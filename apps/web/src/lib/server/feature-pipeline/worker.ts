import { db, sql, type Transaction } from '@/lib/server/db'
import { fromUuid } from '@quackback/ids'
import { logger } from '@/lib/server/logger'
import {
  buildRequestBody,
  snapshotHash,
  closedStatus,
  isPipelineStatus,
  normalizeIssue,
  reconcileStatus,
  type RequestSnapshot,
  type RemoteIssue,
  type PipelineStatus,
} from './model'
import {
  githubRequest,
  verifyRepository,
  ensureLabel,
  recoverCreatedIssue,
  setIssueStatus,
} from './github'

import { applyPipelineStatus, dispatchPendingPipelineStatusEvents } from './status-effects'

const log = logger.child({ component: 'feature-pipeline' })
interface Link {
  post_id: string
  repository: string
  repository_id: string
  issue_node_id: string | null
  issue_number: number | null
  phase: string
  classification: string
  source_snapshot: RequestSnapshot
  baseline_portal: string | null
  baseline_github: string | null
  source_sha256: string
  attempted_at: Date | null
  portal_status: string
  moderation_state: string
  deleted_at: Date | null
}
async function audit(tx: Transaction | typeof db, postId: string, event: string, details: unknown) {
  await tx.execute(sql`INSERT INTO feature_pipeline_audit(post_id,event,details)
    VALUES(${postId}::uuid,${event},${JSON.stringify(details)}::jsonb)`)
}
async function readLink(tx: Transaction, postId: string) {
  const rows =
    await tx.execute(sql`SELECT l.*,s.slug AS portal_status,p.moderation_state,p.deleted_at
    FROM feature_pipeline_links l JOIN posts p ON p.id=l.post_id
    JOIN post_statuses s ON s.id=p.status_id
    JOIN feature_pipeline_boards b ON b.board_id=p.board_id AND b.enabled WHERE l.post_id=${postId}::uuid FOR NO KEY UPDATE OF l`)
  return rows[0] as unknown as Link | undefined
}
async function connectIssue(postId: string, issue: RemoteIssue) {
  await db.transaction(async (tx) => {
    const link = await readLink(tx, postId)
    if (!link) throw new Error('Request link disappeared')
    if (link.phase === 'linked' && link.issue_node_id === issue.node_id) return
    if (link.issue_node_id && link.issue_node_id !== issue.node_id)
      throw new Error('Request already linked elsewhere')
    await tx.execute(sql`UPDATE feature_pipeline_links SET phase='linked',
      issue_node_id=${issue.node_id},issue_number=${issue.number},issue_url=${issue.html_url},
      baseline_portal=NULL,baseline_github=NULL,last_error=NULL,updated_at=now()
      WHERE post_id=${postId}::uuid`)
    await audit(tx, postId, 'issue_linked', { nodeId: issue.node_id, number: issue.number })
  })
}

/** A durable attempted_at is committed BEFORE the external non-idempotent POST. */
async function createOrRecover(postId: string) {
  const candidate = await db.transaction((tx) => readLink(tx, postId))
  if (
    !candidate ||
    candidate.phase === 'linked' ||
    candidate.phase === 'held' ||
    candidate.moderation_state !== 'published' ||
    candidate.deleted_at
  )
    return
  if (snapshotHash(candidate.source_snapshot) !== candidate.source_sha256)
    throw new Error('Request snapshot integrity mismatch')
  await verifyRepository(candidate.repository, candidate.repository_id)
  if (!candidate.attempted_at)
    await ensureLabel(candidate.repository, candidate.repository_id, candidate.classification)

  const claim = await db.transaction(async (tx) => {
    const link = await readLink(tx, postId)
    if (
      !link ||
      link.phase === 'linked' ||
      link.phase === 'held' ||
      link.moderation_state !== 'published' ||
      link.deleted_at
    )
      return null
    if (link.attempted_at) return { link, create: false }
    await tx.execute(sql`UPDATE feature_pipeline_links SET phase='creating',attempted_at=now(),
      updated_at=now() WHERE post_id=${postId}::uuid`)
    await audit(tx, postId, 'issue_create_intent_committed', {})
    return { link, create: true }
  })
  if (!claim) return
  const { link } = claim
  if (snapshotHash(link.source_snapshot) !== link.source_sha256)
    throw new Error('Request snapshot integrity mismatch')
  await verifyRepository(link.repository, link.repository_id)
  const id = fromUuid('post', postId)
  if (!claim.create) {
    const recovered = await recoverCreatedIssue(
      link.repository,
      link.repository_id,
      id,
      link.source_snapshot
    )
    if (recovered) await connectIssue(postId, recovered)
    else
      throw new Error(
        'Creation outcome uncertain; no matching issue found. Staff review required before another POST.'
      )
    return
  }
  const issue = await githubRequest<RemoteIssue>(
    link.repository,
    link.repository_id,
    '/issues',
    'POST',
    {
      title: link.source_snapshot.title,
      body: buildRequestBody(id, link.source_snapshot),
      labels: [link.classification],
    }
  )
  if (!issue.node_id || !issue.number)
    throw new Error('Incomplete GitHub creation response; recover by marker')
  await connectIssue(postId, issue)
}
function remoteMatches(issue: RemoteIssue, status: PipelineStatus) {
  const labels = issue.labels.filter(
    (l) => l.name.startsWith('status:') && isPipelineStatus(l.name.slice(7))
  )
  return (
    labels.length === 1 &&
    labels[0].name === 'status:' + status &&
    issue.state === (closedStatus(status) ? 'closed' : 'open') &&
    (!['declined', 'withdrawn', 'redundant'].includes(status) ||
      issue.state_reason === 'not_planned') &&
    (status !== 'complete' || issue.state_reason === 'completed')
  )
}
async function reconcileLink(postId: string) {
  await db.transaction(async (tx) => {
    const link = await readLink(tx, postId)
    if (
      !link ||
      link.phase !== 'linked' ||
      !link.issue_number ||
      !link.issue_node_id ||
      link.moderation_state !== 'published' ||
      link.deleted_at
    )
      return
    if (!isPipelineStatus(link.portal_status))
      throw new Error('Portal status has no synchronization mapping')
    await verifyRepository(link.repository, link.repository_id)
    const path = '/issues/' + link.issue_number
    const issue = await githubRequest<RemoteIssue>(link.repository, link.repository_id, path)
    if (issue.node_id !== link.issue_node_id)
      throw new Error('Immutable GitHub issue identity mismatch')
    const githubStatus = normalizeIssue(issue, link.baseline_github)
    const decision = reconcileStatus(
      link.portal_status,
      githubStatus,
      link.baseline_portal,
      link.baseline_github
    )
    if (decision.conflict)
      await audit(db, postId, 'concurrent_status_conflict', {
        portal: link.portal_status,
        github: githubStatus,
        resolution: decision.status,
        reason: decision.reason,
      })
    // Compare-and-set the portal status under a row lock. A user edit that
    // happened after our observation wins a fresh reconciliation on the next tick.
    const current =
      await tx.execute(sql`SELECT s.slug FROM posts p JOIN post_statuses s ON s.id=p.status_id
      WHERE p.id=${postId}::uuid FOR UPDATE OF p`)
    if (current[0]?.slug !== link.portal_status)
      throw new Error('Portal status changed during reconciliation; retry')
    const target = await tx.execute(sql`SELECT id FROM post_statuses
      WHERE slug=${decision.status} AND deleted_at IS NULL`)
    if (!target[0]) throw new Error('Required portal status is not configured')
    if (!remoteMatches(issue, decision.status)) {
      await audit(db, postId, 'status_sync_intent', {
        portal: link.portal_status,
        github: githubStatus,
        target: decision.status,
      })
      await setIssueStatus(link.repository, link.repository_id, issue, decision.status)
    }
    // Verify actual remote effects before acknowledging either side.
    const verified = await githubRequest<RemoteIssue>(link.repository, link.repository_id, path)
    if (verified.node_id !== link.issue_node_id || !remoteMatches(verified, decision.status)) {
      throw new Error('GitHub status did not converge; retry')
    }
    await applyPipelineStatus(tx, {
      postId: fromUuid('post', postId),
      expectedStatusSlug: link.portal_status,
      targetStatusSlug: decision.status,
      github: {
        repositoryId: link.repository_id,
        issueNodeId: link.issue_node_id,
        issueNumber: link.issue_number,
      },
      reason: decision.reason,
    })
    if (link.baseline_portal !== decision.status || link.baseline_github !== decision.status) {
      await audit(tx, postId, 'status_synchronized', {
        portalBefore: link.portal_status,
        githubBefore: githubStatus,
        status: decision.status,
        reason: decision.reason,
      })
    }
    await tx.execute(sql`UPDATE feature_pipeline_links SET baseline_portal=${decision.status},
      baseline_github=${decision.status},pending_status=NULL,last_error=NULL,
      checked_at=now(),updated_at=now() WHERE post_id=${postId}::uuid`)
  })
}
let running = false
export async function runFeaturePipeline() {
  if (running) return
  running = true
  try {
    const links = await db.execute(sql`SELECT l.post_id,l.phase FROM feature_pipeline_links l
      JOIN posts p ON p.id=l.post_id
      JOIN feature_pipeline_boards b ON b.board_id=p.board_id AND b.enabled
      WHERE l.phase<>'held' AND p.deleted_at IS NULL AND p.moderation_state='published'
      ORDER BY l.checked_at NULLS FIRST,l.created_at LIMIT 100`)
    let cursor = 0
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < links.length) {
          const row = links[cursor++]
          const postId = String(row.post_id)
          try {
            if (row.phase !== 'linked') await createOrRecover(postId)
            await reconcileLink(postId)
          } catch (error) {
            const reason = error instanceof Error ? error.message : 'Feature synchronization failed'
            // Durable, queryable errors. No webhook acknowledges a failed mutation.
            await db.execute(sql`UPDATE feature_pipeline_links SET last_error=${reason},
          checked_at=now(),updated_at=now() WHERE post_id=${postId}::uuid`)
            log.error({ post_id: postId, reason }, 'feature synchronization pending')
          }
        }
      })
    )
    await dispatchPendingPipelineStatusEvents()
  } finally {
    running = false
  }
}
export function startFeaturePipeline() {
  if (process.env.FEATURE_PIPELINE_ENABLED !== 'true') return
  void runFeaturePipeline().catch((error) => log.error({ error }, 'feature pipeline failed'))
  const timer = setInterval(() => {
    void runFeaturePipeline().catch((error) => log.error({ error }, 'feature pipeline failed'))
  }, 30_000)
  timer.unref()
}
