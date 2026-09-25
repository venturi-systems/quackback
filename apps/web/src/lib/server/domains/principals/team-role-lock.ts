/**
 * The team-role advisory lock (landing-page#2309, owner decisions 6 and 7).
 *
 * Every write that gives, changes or removes a team role holds this lock for
 * its transaction: the writers in team-designation.ts (Admin > Team,
 * invitations, the VENTURI_TEAM_ADMIN_EMAILS promotion, SSO auto-provisioning)
 * and the two bootstrap claims (onboarding and the first SSO sign-in). A rule
 * check and the write it guards therefore see the state the previous writer
 * committed, so two writers can never each count the other as the remaining
 * administrator.
 *
 * Lock order: a transaction that also holds the bootstrap lock
 * (`quackback:sso_bootstrap`) takes that one first. No path takes the
 * bootstrap lock while it holds this one, so the two never deadlock.
 *
 * Kept apart from team-designation.ts so a caller that only needs the lock
 * does not load the designation writers.
 */

import type { Transaction } from '@/lib/server/db'

/** Advisory-lock key every team-role writer takes. Stable across pods. */
export const TEAM_ROLE_LOCK_KEY = 'quackback:team_roles'

/** Take the team-role lock for the rest of `tx`. Released at commit or rollback. */
export async function acquireTeamRoleLock(tx: Pick<Transaction, 'execute'>): Promise<void> {
  const { sql } = await import('@/lib/server/db')
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${TEAM_ROLE_LOCK_KEY}))`)
}
