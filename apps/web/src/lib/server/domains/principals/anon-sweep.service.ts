/**
 * Anonymous-principal sweep. Durable anon tokens (P0.1) keep anonymous
 * principals around far longer than the old per-session lifetime, so abandoned
 * empties accumulate and degrade the per-IP anon-vote rate limit (which JOINs
 * sessions + principals). This reclaims them.
 *
 * Only TRULY EMPTY anon principals are deleted — created beyond the retention
 * window, no live session, and no content anywhere (posts/votes/comments/
 * comment_reactions/conversations/messages/subscriptions/notifications). A
 * principal that authored anything is left untouched.
 *
 * The NOT EXISTS list must cover every table where an anon actor can author
 * content, because the FKs are a mix: chat FKs are onDelete:restrict (a missed
 * one would throw and be caught), but content like comment_reactions is
 * onDelete:CASCADE — a missing guard there would NOT throw; it would silently
 * cascade-delete real content. So the guard, not the catch block, is the
 * safety net for cascade tables. (notification_preferences / unsubscribe_tokens
 * also cascade but are derived preference state, so sweeping them is intended.)
 *
 * The scan that picks candidates is only a shortlist. Between it and the delete
 * a candidate can vote, comment, start a live session, or be absorbed by a
 * sign-up (which turns it into a contributor, type 'user'). Each candidate is
 * therefore removed in its own transaction that (1) locks the principal row and
 * its user row, skipping the candidate if anyone holds either, and then (2)
 * deletes the principal only if the same predicate still holds, on a snapshot
 * taken after the locks. A write that references the principal or its user
 * takes a key-share lock on that row until it commits, so it is either
 * committed before step 2 reads (and seen) or blocked until this transaction
 * ends. Sessions and the user row are deleted only for the user the principal
 * delete returned. The predicate is defined once (sweepablePredicate), so the
 * shortlist and the delete cannot drift apart. HYG-32 (landing-page#2309).
 *
 * A candidate that is skipped (busy or no longer empty) or hits an unexpected
 * restrict reference is left for a later run; the batch carries on.
 */
import type { SQL } from 'drizzle-orm'
import { db, eq, sql, principal, session, user } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'anon-sweep' })

export interface AnonSweepResult {
  /** Eligible empties found this run (bounded by batchSize). */
  candidates: number
  /**
   * Actually deleted: candidates minus any left in place because another
   * transaction held them, they stopped being empty after the scan, or an
   * unexpected FK refused the delete.
   */
  deleted: number
}

/**
 * The one definition of a sweepable anonymous principal, over the alias `pr`.
 * Both the candidate scan and the in-transaction delete use it.
 */
function sweepablePredicate(cutoffIso: string): SQL {
  return sql`pr.type = 'anonymous'
      AND pr.user_id IS NOT NULL
      AND pr.created_at < ${cutoffIso}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM session s WHERE s.user_id = pr.user_id AND s.expires_at > now())
      AND NOT EXISTS (SELECT 1 FROM posts WHERE principal_id = pr.id)
      AND NOT EXISTS (SELECT 1 FROM votes WHERE principal_id = pr.id)
      AND NOT EXISTS (SELECT 1 FROM comments WHERE principal_id = pr.id)
      AND NOT EXISTS (SELECT 1 FROM comment_reactions WHERE principal_id = pr.id)
      AND NOT EXISTS (SELECT 1 FROM conversations WHERE visitor_principal_id = pr.id)
      AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE principal_id = pr.id)
      AND NOT EXISTS (SELECT 1 FROM post_subscriptions WHERE principal_id = pr.id)
      AND NOT EXISTS (SELECT 1 FROM in_app_notifications WHERE principal_id = pr.id)`
}

type SweepOutcome = 'deleted' | 'busy' | 'no_longer_empty'

/**
 * Lock, re-check and delete one candidate. Returns what happened; deletes
 * nothing unless the principal delete itself returned a row.
 */
async function sweepOne(principalId: string, cutoffIso: string): Promise<SweepOutcome> {
  return db.transaction(async (tx): Promise<SweepOutcome> => {
    // SKIP LOCKED: a row someone holds is in use right now, so it is not
    // abandoned. Waiting instead could deadlock with a sign-up, which takes the
    // user row before the principal row.
    const locked = (await tx.execute(sql`
      SELECT pr.id
      FROM principal pr
      JOIN "user" u ON u.id = pr.user_id
      WHERE pr.id = ${principalId}
      FOR UPDATE OF pr, u SKIP LOCKED
    `)) as unknown as Array<{ id: string }>
    if (locked.length === 0) return 'busy'

    // A new statement, so a new snapshot: it sees everything committed before
    // the locks above were granted, and nothing can reference either row now.
    const removed = (await tx.execute(sql`
      DELETE FROM principal pr
      WHERE pr.id = ${principalId}
        AND ${sweepablePredicate(cutoffIso)}
      RETURNING pr.user_id AS user_id
    `)) as unknown as Array<{ user_id: string }>
    if (removed.length === 0) return 'no_longer_empty'

    const userId = removed[0].user_id
    await tx.delete(session).where(eq(session.userId, userId as never))
    await tx.delete(user).where(eq(user.id, userId as never))
    return 'deleted'
  })
}

export async function sweepAnonymousPrincipals(opts?: {
  olderThanDays?: number
  batchSize?: number
}): Promise<AnonSweepResult> {
  const olderThanDays = opts?.olderThanDays ?? 30
  const batchSize = opts?.batchSize ?? 500
  const cutoffIso = new Date(Date.now() - olderThanDays * 86_400_000).toISOString()

  const rows = await db.execute(sql`
    SELECT pr.id AS principal_id
    FROM principal pr
    WHERE ${sweepablePredicate(cutoffIso)}
    LIMIT ${batchSize}
  `)

  const targets = rows as unknown as Array<{ principal_id: string }>
  let deleted = 0
  for (const t of targets) {
    try {
      const outcome = await sweepOne(t.principal_id, cutoffIso)
      if (outcome === 'deleted') {
        deleted++
      } else {
        log.info({ principal_id: t.principal_id, outcome }, 'anon-sweep left principal in place')
      }
    } catch (err) {
      // An unexpected referencing row (FK restrict) — leave it and move on.
      log.warn({ principal_id: t.principal_id, err }, 'anon-sweep skipped principal')
    }
  }

  return { candidates: targets.length, deleted }
}
