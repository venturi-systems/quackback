/**
 * Team identity rule: who may exercise a team role (member or admin).
 *
 * Venturi's owner decisions 6 and 7 (venturi-systems/landing-page#2309,
 * 2026-09-22): anyone who signs up with Google or GitHub may use the portal,
 * but a team role takes effect only for an account that
 *
 *   1. has a Google or GitHub account linked (never the password credential
 *      alone, never a magic link, a widget identify or an OIDC provider),
 *   2. has its email address marked verified (`user.emailVerified`), and
 *   3. whose address is at one of VENTURI_TEAM_EMAIL_DOMAINS (exact hostname;
 *      subdomains never match).
 *
 * What rule 2 reads is the account's own flag, not the provider's claim at the
 * moment of each sign-in. Five things keep that flag honest: Google and
 * GitHub are not trusted providers (auth/index.ts), so Better Auth links one of
 * them to an existing account only when the provider itself reports the
 * address verified; a social sign-in that would create or open a team-domain
 * account whose address is unverified is refused, so no provider account that
 * never proved the address stays linked to it (auth/hooks.ts,
 * team_email_unverified); an anonymous user absorbing a sign-up keeps the new
 * account's own flag (merge-anonymous.ts, absorbedSignUpIdentity); the flag of
 * a team account or team-domain address cannot be written through REST
 * identify or user update (user.identify.ts); and the admin UI cannot edit a
 * team member's address (admin.ts, TEAM_EMAIL_LOCKED).
 *
 * The rule is enforced twice: every write that assigns a team role refuses an
 * identity that does not qualify (team-designation.ts), and every read that
 * decides authority treats a stored team role on such an identity as a
 * contributor (`resolveTeamRole`). The read side is what neutralises legacy
 * rows, such as a password bootstrap administrator, without rewriting them.
 */

import type { UserId } from '@quackback/ids'
import type { Database } from '@/lib/server/db'
import { config } from '@/lib/server/config'
import { effectiveRole, isTeamMember, type Role } from '@/lib/shared/roles'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'team-identity' })

/** Sign-in providers whose verified email can back a team role. */
export const TEAM_IDENTITY_PROVIDER_IDS = ['google', 'github'] as const

/** The facts the rule reads about one account. */
export interface TeamIdentity {
  email: string | null | undefined
  emailVerified: boolean | null | undefined
  /** Better Auth `account.provider_id` values linked to the user. */
  providerIds: readonly string[]
}

/** Why an identity cannot hold a team role; null when it can. */
export type TeamIdentityGap =
  'email_missing' | 'email_domain' | 'email_unverified' | 'provider_missing'

/** Plain-language reasons, shared by server errors and the Admin > Team panel. */
export const TEAM_IDENTITY_GAP_MESSAGES: Record<TeamIdentityGap, string> = {
  email_missing: 'The account has no email address.',
  email_domain: 'The email address is not at a team domain.',
  email_unverified: 'Google or GitHub has not verified the email address.',
  provider_missing: 'The account has not signed in with Google or GitHub.',
}

/**
 * Refusal text for a write that would create an account at a team domain, or
 * change the verification flag of a team account, anywhere but a Google or
 * GitHub sign-in (REST identify, REST user update).
 *
 * Better Auth links a later Google or GitHub sign-in to an existing account
 * only while that account's address is already marked verified. An unverified
 * row created elsewhere would therefore block the person's own first sign-in,
 * and a flag written elsewhere would either stand in for a verification no
 * provider made or switch off a working administrator's team access.
 */
export const TEAM_IDENTITY_LOCKED_MESSAGE =
  'Team accounts and addresses at a team domain are created and verified only by signing in with Google or GitHub.'

/** Configured team domains; the Venturi default if the value is unavailable. */
export function configuredTeamDomains(): readonly string[] {
  const domains = config.teamEmailDomains
  return Array.isArray(domains) && domains.length > 0 ? domains : ['venturi.systems']
}

/** Configured designated administrator addresses (none if unavailable). */
export function configuredTeamAdminEmails(): readonly string[] {
  const emails = config.teamAdminEmails
  return Array.isArray(emails) ? emails : []
}

/** Lower-cased domain of an address, or null when there is none. */
export function emailDomainOf(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return null
  return trimmed.slice(at + 1)
}

/** True when the address is at one of the team domains (exact match). */
export function isTeamDomainEmail(
  email: string | null | undefined,
  domains: readonly string[] = configuredTeamDomains()
): boolean {
  const domain = emailDomainOf(email)
  return domain !== null && domains.includes(domain)
}

/**
 * The first rule an identity fails, or null when it may hold a team role.
 * Checked in a fixed order so the message names the most basic gap.
 */
export function teamIdentityGap(
  identity: TeamIdentity,
  domains: readonly string[] = configuredTeamDomains()
): TeamIdentityGap | null {
  if (!identity.email || emailDomainOf(identity.email) === null) return 'email_missing'
  if (!isTeamDomainEmail(identity.email, domains)) return 'email_domain'
  if (identity.emailVerified !== true) return 'email_unverified'
  const linked = identity.providerIds.some((id) =>
    (TEAM_IDENTITY_PROVIDER_IDS as readonly string[]).includes(id)
  )
  if (!linked) return 'provider_missing'
  return null
}

/** True when the identity may hold a team role. */
export function isTeamIdentityEligible(
  identity: TeamIdentity,
  domains: readonly string[] = configuredTeamDomains()
): boolean {
  return teamIdentityGap(identity, domains) === null
}

/** True when the address is one VENTURI_TEAM_ADMIN_EMAILS designates. */
export function isDesignatedAdminEmail(
  email: string | null | undefined,
  adminEmails: readonly string[] = configuredTeamAdminEmails()
): boolean {
  if (typeof email !== 'string') return false
  return adminEmails.includes(email.trim().toLowerCase())
}

/** Minimal query surface shared by `db` and a transaction. */
export type IdentityExecutor = { query: Database['query'] }

/** Provider ids linked to a user. */
export async function loadProviderIds(
  userId: UserId,
  executor?: IdentityExecutor
): Promise<string[]> {
  const { db, account, eq } = await import('@/lib/server/db')
  const rows = await (executor ?? db).query.account.findMany({
    where: eq(account.userId, userId),
    columns: { providerId: true },
  })
  return rows.map((row) => row.providerId)
}

/**
 * Load the facts the rule reads. `known` lets a session-resolving caller pass
 * the email and verification flag it already holds, so only the linked
 * providers are read from the database.
 */
export async function loadTeamIdentity(
  userId: UserId,
  known?: { email: string | null | undefined; emailVerified: boolean | null | undefined },
  executor?: IdentityExecutor
): Promise<TeamIdentity | null> {
  const { db, user, eq } = await import('@/lib/server/db')
  let email = known?.email
  let emailVerified = known?.emailVerified
  if (!known) {
    const row = await (executor ?? db).query.user.findFirst({
      where: eq(user.id, userId),
      columns: { email: true, emailVerified: true },
    })
    if (!row) return null
    email = row.email
    emailVerified = row.emailVerified
  }
  const providerIds = await loadProviderIds(userId, executor)
  return { email, emailVerified, providerIds }
}

// Log each capped principal once per process: the check runs per request.
const loggedCappedPrincipals = new Set<string>()

/**
 * The role a principal may exercise right now.
 *
 * A non-human principal never exercises a team role (effectiveRole). A human
 * principal exercises a stored team role only while its identity satisfies the
 * team identity rule; otherwise it acts as a contributor. Pass `identity` when
 * the caller already loaded it; otherwise it is read for team roles only, so a
 * contributor's request costs no extra query.
 */
export async function resolveTeamRole(
  principal: {
    id: string
    role: string | null | undefined
    type: string | null | undefined
    userId: string | null | undefined
  },
  identity?: TeamIdentity | null
): Promise<Role> {
  const role = effectiveRole(principal.role, principal.type) ?? 'user'
  if (!isTeamMember(role)) return role
  if (!principal.userId) return 'user'

  const resolved = identity ?? (await loadTeamIdentity(principal.userId as UserId))
  const gap = resolved ? teamIdentityGap(resolved) : 'email_missing'
  if (gap === null) return role

  if (!loggedCappedPrincipals.has(principal.id)) {
    loggedCappedPrincipals.add(principal.id)
    log.warn(
      { principal_id: principal.id, stored_role: principal.role, gap },
      'stored team role ignored: identity does not satisfy the team identity rule'
    )
  }
  return 'user'
}

/**
 * The principals, among rows that may hold a stored team role, that may
 * exercise it now (resolveTeamRole). For choosing who receives team-only
 * content, such as a private comment or a support conversation: a stored
 * team role on an identity that fails the team identity rule acts as a
 * contributor, so it must not receive what only the team may read either.
 * Only rows with a stored team role cost an identity read.
 */
export async function principalsActingAsTeam<
  T extends {
    id: string
    role: string | null | undefined
    type: string | null | undefined
    userId: string | null | undefined
  },
>(rows: readonly T[]): Promise<T[]> {
  const acting: T[] = []
  for (const row of rows) {
    if (isTeamMember(await resolveTeamRole(row))) acting.push(row)
  }
  return acting
}

/** Test hook: forget which principals were already logged. */
export function _resetTeamIdentityLogForTests(): void {
  loggedCappedPrincipals.clear()
}
