/**
 * Audit row for a post status change (landing-page#2309).
 *
 * A status change emails subscribers and moves the public roadmap, so the
 * audit log records who made it and the before and after status, next to the
 * per-post activity feed (which is deleted with the post). Best effort: the
 * status change never fails because of the audit write.
 */

import type { PostId, PrincipalId, StatusId, UserId } from '@quackback/ids'
import { recordAuditSafely } from '@/lib/server/audit/audit-safe'

export async function recordPostStatusAudit(input: {
  postId: PostId
  actor: { principalId: PrincipalId; userId?: UserId; email?: string; displayName?: string }
  from: { id: StatusId | string | null; name: string }
  to: { id: StatusId | string; name: string; slug?: string | null }
}): Promise<void> {
  await recordAuditSafely(
    {
      event: 'post.status.changed',
      actor: {
        userId: input.actor.userId ?? null,
        email: input.actor.email ?? null,
        type: input.actor.userId ? 'user' : 'service',
      },
      target: { type: 'post', id: input.postId },
      before: { statusId: input.from.id, status: input.from.name },
      after: { statusId: input.to.id, status: input.to.name, slug: input.to.slug ?? null },
      metadata: { principalId: input.actor.principalId },
    },
    'request'
  )
}
