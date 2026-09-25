/**
 * The team-role advisory lock (landing-page#2309, owner decisions 6 and 7).
 *
 * Every write that gives, changes or removes a person's team role holds this
 * lock for its transaction: the writers in team-designation.ts (Admin > Team,
 * invitations, the VENTURI_TEAM_ADMIN_EMAILS promotion, SSO auto-provisioning)
 * and the two bootstrap claims (onboarding and the first SSO sign-in). A rule
 * check and the write it guards therefore see the state the previous writer
 * committed, so two writers can never each count the other as the remaining
 * administrator.
 *
 * Not every write of principal.role takes it. These go without it, and none
 * can change who counts as an administrator (countEligibleAdmins counts only
 * principals of type 'user' with role 'admin'):
 *  - API-key service principals (type 'service'): createServicePrincipal in
 *    principal.service.ts gives one the admin or member role, and revokeApiKey
 *    in api-key.service.ts sets it back to 'user'.
 *  - A new principal created as a contributor (role 'user'): the Better Auth
 *    user.create hook in auth/index.ts, the lazy creation in
 *    functions/auth-helpers.ts, functions/widget-auth.ts and
 *    routes/api/widget/identify.ts, users/user.identify.ts, feedback ingestion
 *    (author-resolver.ts), import (user-resolver.ts) and createPortalUserFn in
 *    functions/admin.ts.
 *  - The anonymous sign-up absorption (onLinkAccount in auth/index.ts), which
 *    sets role 'user' on a principal that was anonymous until that write, and
 *    an anonymous principal never counts.
 * Demo and test tooling (packages/db/src/seed.ts, e2e/scripts/ensure-role.ts)
 * also writes roles directly. A new write that can change who holds a team
 * role must take this lock.
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
