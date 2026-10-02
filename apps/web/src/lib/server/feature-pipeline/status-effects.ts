/**
 * GitHub-origin status effects share the reconciliation transaction. Native
 * audit/activity writes must fail the transaction rather than silently vanish.
 * Only dispatch is deferred: its immutable event remains in an outbox until
 * strict native target resolution and queue admission both succeed.
 */
import { db, sql, auditLog, postActivity, type Transaction } from '@/lib/server/db'
import { fromUuid, toUuid, type PostId } from '@quackback/ids'
import type { PostStatusChangedEvent } from '@/lib/server/events/types'
import type { PipelineStatus } from './model'

export interface PipelineStatusInput {
  postId: PostId
  expectedStatusSlug: PipelineStatus
  targetStatusSlug: PipelineStatus
  github: { repositoryId: string; issueNodeId: string; issueNumber: number }
  reason: string
}

export async function applyPipelineStatus(
  tx: Transaction,
  input: PipelineStatusInput
): Promise<{ changed: boolean; eventId: string | null }> {
  const postUuid = toUuid(input.postId)
  const rows = await tx.execute(sql`SELECT p.title,p.board_id,b.slug AS board_slug,
      p.status_id,s.name AS status_name,s.slug AS status_slug,s.color AS status_color,
      p.deleted_at,p.moderation_state,b.deleted_at AS board_deleted_at
    FROM posts p JOIN boards b ON b.id=p.board_id
    JOIN post_statuses s ON s.id=p.status_id
    WHERE p.id=${postUuid}::uuid FOR UPDATE OF p`)
  const current = rows[0]
  if (
    !current ||
    current.deleted_at ||
    current.board_deleted_at ||
    current.moderation_state !== 'published'
  ) {
    throw new Error('Post is no longer eligible for status synchronization')
  }
  if (current.status_slug !== input.expectedStatusSlug) {
    throw new Error('Portal status changed during reconciliation; retry')
  }
  if (current.status_slug === input.targetStatusSlug) return { changed: false, eventId: null }

  const targets = await tx.execute(sql`SELECT id,name,slug,color FROM post_statuses
    WHERE slug=${input.targetStatusSlug} AND deleted_at IS NULL FOR SHARE`)
  if (targets.length !== 1) throw new Error('Required portal status is not uniquely configured')
  const target = targets[0]
  const updated =
    await tx.execute(sql`UPDATE posts SET status_id=${target.id}::uuid,updated_at=now()
    WHERE id=${postUuid}::uuid AND status_id=${current.status_id}::uuid
      AND deleted_at IS NULL AND moderation_state='published' RETURNING id`)
  if (updated.length !== 1) throw new Error('Portal status changed during reconciliation; retry')

  const eventId = globalThis.crypto.randomUUID()
  const metadata = {
    source: 'github-feature-pipeline',
    eventId,
    repositoryId: input.github.repositoryId,
    issueNodeId: input.github.issueNodeId,
    issueNumber: input.github.issueNumber,
    reason: input.reason,
  }
  await tx.insert(auditLog).values({
    eventType: 'post.status.changed',
    eventOutcome: 'success',
    actorType: 'service',
    actorRole: 'service',
    targetType: 'post',
    targetId: input.postId,
    beforeValue: {
      statusId: fromUuid('status', String(current.status_id)),
      status: String(current.status_name),
    },
    afterValue: {
      statusId: fromUuid('status', String(target.id)),
      status: String(target.name),
      slug: String(target.slug),
    },
    metadata,
  })
  await tx.insert(postActivity).values({
    postId: input.postId,
    principalId: null,
    type: 'status.changed',
    metadata: {
      fromName: String(current.status_name),
      fromColor: current.status_color ?? null,
      toName: String(target.name),
      toSlug: String(target.slug),
      toColor: target.color ?? null,
      // Activity may be customer-visible; private GitHub identity stays in audit_log.
      source: metadata.source,
      eventId,
    },
  })
  const event: PostStatusChangedEvent = {
    id: eventId,
    timestamp: new Date().toISOString(),
    type: 'post.status_changed',
    actor: {
      type: 'service',
      service: 'github-feature-pipeline',
      displayName: 'GitHub synchronization',
    },
    data: {
      post: {
        id: input.postId,
        title: String(current.title),
        boardId: fromUuid('board', String(current.board_id)),
        boardSlug: String(current.board_slug),
      },
      previousStatus: String(current.status_name),
      newStatus: String(target.name),
    },
  }
  await tx.execute(sql`INSERT INTO feature_pipeline_status_outbox(event_id,post_id,payload,created_at)
    VALUES(${eventId}::uuid,${postUuid}::uuid,${JSON.stringify(event)}::jsonb,clock_timestamp())`)
  return { changed: true, eventId }
}

/**
 * Queue admission is at least once. Stable per-recipient BullMQ IDs survive
 * enqueue/acknowledgment crashes; retained jobs must not be pruned while an
 * outbox acknowledgment can still be retried. Provider delivery remains at
 * least once (a provider response can be lost after it accepts a message).
 */
export async function dispatchPendingPipelineStatusEvents(limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid outbox batch size')
  const candidates = await db.execute(sql`SELECT o.event_id
    FROM feature_pipeline_status_outbox o
    WHERE o.delivered_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM feature_pipeline_status_outbox earlier
      WHERE earlier.post_id=o.post_id AND earlier.delivered_at IS NULL
        AND (earlier.created_at,earlier.event_id)<(o.created_at,o.event_id))
    ORDER BY o.created_at,o.event_id LIMIT ${limit}`)
  let delivered = 0
  let failed = 0
  for (const candidate of candidates) {
    const outcome = await db.transaction(async (tx) => {
      const rows = await tx.execute(sql`SELECT o.event_id,o.payload
        FROM feature_pipeline_status_outbox o
        WHERE o.event_id=${candidate.event_id}::uuid AND o.delivered_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM feature_pipeline_status_outbox earlier
            WHERE earlier.post_id=o.post_id AND earlier.delivered_at IS NULL
              AND (earlier.created_at,earlier.event_id)<(o.created_at,o.event_id))
        FOR UPDATE OF o SKIP LOCKED`)
      if (!rows[0]) return 'skipped'
      const event = rows[0].payload as PostStatusChangedEvent
      if (event.id !== String(rows[0].event_id) || event.type !== 'post.status_changed') {
        throw new Error('Invalid durable status event identity')
      }
      try {
        const { processEvent } = await import('@/lib/server/events/process')
        await processEvent(event, { durable: true })
      } catch {
        await tx.execute(sql`UPDATE feature_pipeline_status_outbox
          SET attempts=attempts+1,last_error='Native status dispatch failed; retry pending'
          WHERE event_id=${candidate.event_id}::uuid`)
        return 'failed'
      }
      await tx.execute(sql`UPDATE feature_pipeline_status_outbox
        SET delivered_at=now(),attempts=attempts+1,last_error=NULL
        WHERE event_id=${candidate.event_id}::uuid`)
      return 'delivered'
    })
    if (outcome === 'delivered') delivered++
    if (outcome === 'failed') failed++
  }
  return { delivered, failed }
}
