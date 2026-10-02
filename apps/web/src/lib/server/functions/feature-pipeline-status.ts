import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { postIdSchema } from '@quackback/ids/zod'
import { toUuid } from '@quackback/ids'
import { requireAuth } from '@/lib/server/functions/auth-helpers'
import { db, sql } from '@/lib/server/db'

export const getFeaturePipelineStatusFn = createServerFn({ method: 'GET' })
  .validator(z.object({ postId: postIdSchema }))
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin', 'member'] })
    if (process.env.FEATURE_PIPELINE_ENABLED !== 'true') return null
    const rows = await db.execute(sql`SELECT phase,issue_url,last_error,checked_at,created_at,
      (SELECT count(*)::int FROM feature_pipeline_status_outbox o
        WHERE o.post_id=l.post_id AND o.delivered_at IS NULL) AS pending_events
      FROM feature_pipeline_links l WHERE post_id=${toUuid(data.postId)}::uuid`)
    if (!rows[0]) {
      const legacy = await db.execute(sql`SELECT reason FROM feature_pipeline_legacy_posts
        WHERE post_id=${toUuid(data.postId)}::uuid`)
      return legacy[0]
        ? {
            phase: 'historical',
            message: String(legacy[0].reason),
            issueUrl: null,
            checkedAt: null,
            delayed: false,
            pendingEvents: 0,
          }
        : null
    }
    const row = rows[0]
    const checked = row.checked_at ? new Date(String(row.checked_at)) : null
    return {
      phase: String(row.phase),
      message: row.last_error ? String(row.last_error) : null,
      issueUrl: row.issue_url ? String(row.issue_url) : null,
      checkedAt: checked?.toISOString() ?? null,
      delayed: Date.now() - (checked ?? new Date(String(row.created_at))).getTime() > 300_000,
      pendingEvents: Number(row.pending_events),
    }
  })
export const retryFeaturePipelineFn = createServerFn({ method: 'POST' })
  .validator(z.object({ postId: postIdSchema }))
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin', 'member'] })
    if (process.env.FEATURE_PIPELINE_ENABLED !== 'true')
      throw new Error('Feature routing is not enabled')
    // Retry observation/reconciliation only. Never erase attempted_at or repeat an uncertain POST.
    await db.execute(sql`UPDATE feature_pipeline_links SET checked_at=NULL
      WHERE post_id=${toUuid(data.postId)}::uuid AND phase<>'held'`)
    return { queued: true }
  })
