/**
 * Team designation: every write that gives, changes or removes a team role.
 *
 * Three rules hold here, for every writer (Admin > Team, invitations, the
 * VENTURI_TEAM_ADMIN_EMAILS promotion and SSO auto-provisioning; the onboarding
 * and first-SSO bootstrap claims check the first rule themselves):
 *
 *  - A promotion to member or admin needs an identity that satisfies the
 *    team identity rule (team-identity.ts). The server refuses anything else.
 *  - A change never leaves the workspace without a human administrator whose
 *    identity satisfies that rule.
 *  - Nobody changes or removes their own team role.
 *
 * Every writer, the bootstrap claims included, reads the principal, checks the
 * rules and writes in one transaction that holds the team-role advisory lock
 * (team-role-lock.ts). Two concurrent writers therefore never each see the
 * other as the remaining administrator, and a role another writer set since a
 * caller's first read is the one the rules check.
 *
 * Promotion from VENTURI_TEAM_ADMIN_EMAILS happens at a qualifying Google or
 * GitHub sign-in and at the next authenticated request of an existing
 * session. The list only promotes; demotion is always a person's act.
 */

import { generateId, type InviteId, type PrincipalId, type UserId } from '@quackback/ids'
import type { Transaction } from '@/lib/server/db'
import { ForbiddenError, NotFoundError } from '@/lib/shared/errors'
import { isAdmin, isTeamMember, type Role } from '@/lib/shared/roles'
import {
  configuredTeamDomains,
  TEAM_IDENTITY_GAP_MESSAGES,
  TEAM_IDENTITY_PROVIDER_IDS,
  isDesignatedAdminEmail,
  isTeamDomainEmail,
  loadTeamIdentity,
  teamIdentityGap,
  type IdentityExecutor,
  type TeamIdentityGap,
} from './team-identity'
import { logger } from '@/lib/server/logger'
import { acquireTeamRoleLock } from './team-role-lock'

export { TEAM_ROLE_LOCK_KEY } from './team-role-lock'

const log = logger.child({ component: 'team-designation' })

const ROLE_RANK: Record<Role, number> = { user: 0, member: 1, admin: 2 }

function rankOf(role: string | null | undefined): number {
  return role === 'admin' || role === 'member' || role === 'user' ? ROLE_RANK[role] : 0
}

/** "@venturi.systems", or "@a.example or @b.example" for several domains. */
export function teamDomainsLabel(domains: readonly string[] = configuredTeamDomains()): string {
  return domains.map((d) => `@${d}`).join(' or ')
}

/** The refusal text for an identity that cannot hold a team role. */
export function teamIdentityRequiredMessage(gap: TeamIdentityGap): string {
  return (
    `Team roles are limited to verified ${teamDomainsLabel()} accounts that sign in with ` +
    `Google or GitHub. ${TEAM_IDENTITY_GAP_MESSAGES[gap]}`
  )
}

/** Run `fn` in a transaction that holds the team-role advisory lock. */
export async function withTeamRoleLock<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const { db } = await import('@/lib/server/db')
  return db.transaction(async (tx) => {
    await acquireTeamRoleLock(tx)
    return fn(tx)
  })
}

/** The first team-identity gap for a user, or null when it may hold a team role. */
export async function teamRoleGapForUser(
  userId: UserId | null | undefined,
  executor?: IdentityExecutor
): Promise<TeamIdentityGap | null> {
  const identity = userId ? await loadTeamIdentity(userId, undefined, executor) : null
  return identity ? teamIdentityGap(identity) : 'email_missing'
}

/**
 * Refuse a team role for a user whose identity does not satisfy the rule.
 * Throws ForbiddenError `TEAM_IDENTITY_REQUIRED` naming the first gap.
 */
export async function assertTeamRoleAssignable(
  userId: UserId | null | undefined,
  executor?: IdentityExecutor
): Promise<void> {
  const gap = await teamRoleGapForUser(userId, executor)
  if (gap !== null) {
    throw new ForbiddenError('TEAM_IDENTITY_REQUIRED', teamIdentityRequiredMessage(gap))
  }
}

/**
 * Human administrators, other than `excludePrincipalId`, whose identity
 * satisfies the rule. Uses the same predicate as every authority check, so
 * "the last administrator" means the last one who can actually act.
 */
export async function countEligibleAdmins(
  tx: Transaction,
  excludePrincipalId?: PrincipalId | null
): Promise<number> {
  const { principal, account, and, eq, inArray } = await import('@/lib/server/db')
  const admins = await tx.query.principal.findMany({
    where: and(eq(principal.role, 'admin'), eq(principal.type, 'user')),
    columns: { id: true, userId: true },
    with: { user: { columns: { email: true, emailVerified: true } } },
  })

  const candidates = admins.filter((a) => a.id !== excludePrincipalId && a.userId && a.user)
  if (candidates.length === 0) return 0

  const links = await tx.query.account.findMany({
    where: and(
      inArray(
        account.userId,
        candidates.map((c) => c.userId as UserId)
      ),
      inArray(account.providerId, [...TEAM_IDENTITY_PROVIDER_IDS])
    ),
    columns: { userId: true, providerId: true },
  })
  const providersByUser = new Map<string, string[]>()
  for (const link of links) {
    const list = providersByUser.get(link.userId) ?? []
    list.push(link.providerId)
    providersByUser.set(link.userId, list)
  }

  return candidates.filter(
    (c) =>
      teamIdentityGap({
        email: c.user?.email,
        emailVerified: c.user?.emailVerified,
        providerIds: providersByUser.get(c.userId as string) ?? [],
      }) === null
  ).length
}

/**
 * The rules a role change must pass, checked inside the caller's team-role
 * transaction against the principal as that transaction read it:
 *
 * - a promotion (to a higher role) needs a human principal whose identity
 *   satisfies the team identity rule;
 * - taking `admin` away from a human principal needs another eligible human
 *   administrator to remain.
 *
 * Throws ForbiddenError `TEAM_IDENTITY_REQUIRED` or `LAST_ADMIN`.
 */
async function assertRoleChangeAllowed(
  tx: Transaction,
  target: { id: string; type: string; role: string; userId: string | null },
  newRole: Role
): Promise<void> {
  if (rankOf(newRole) > rankOf(target.role)) {
    if (target.type !== 'user') {
      throw new ForbiddenError(
        'TEAM_IDENTITY_REQUIRED',
        'Only a person can hold a team role. Service and anonymous principals cannot.'
      )
    }
    await assertTeamRoleAssignable(target.userId as UserId | null, tx)
  }

  if (isAdmin(target.role) && newRole !== 'admin' && target.type === 'user') {
    const remaining = await countEligibleAdmins(tx, target.id as PrincipalId)
    if (remaining < 1) {
      throw new ForbiddenError(
        'LAST_ADMIN',
        newRole === 'user' ? 'Cannot remove the last admin' : 'Cannot demote the last admin'
      )
    }
  }
}

export interface ChangeTeamRoleResult {
  previousRole: string
  newRole: Role
  userId: UserId | null
  changed: boolean
}

/**
 * Set a principal's workspace role under the team-role lock.
 *
 * - Promotions (to a higher role) need a human principal whose identity
 *   satisfies the team identity rule.
 * - Taking `admin` away from a human principal needs another eligible human
 *   administrator to remain.
 * - `requireTeamTarget` keeps the member-management paths from touching a
 *   contributor (they answer MEMBER_NOT_FOUND, as before).
 */
export async function changeTeamRole(input: {
  principalId: PrincipalId
  newRole: Role
  actingPrincipalId?: PrincipalId | null
  requireTeamTarget: boolean
}): Promise<ChangeTeamRoleResult> {
  if (input.actingPrincipalId && input.actingPrincipalId === input.principalId) {
    throw input.newRole === 'user'
      ? new ForbiddenError('CANNOT_REMOVE_SELF', 'You cannot remove yourself from the team')
      : new ForbiddenError('CANNOT_MODIFY_SELF', 'You cannot change your own role')
  }

  const { principal, eq } = await import('@/lib/server/db')
  return withTeamRoleLock(async (tx) => {
    const target = await tx.query.principal.findFirst({
      where: eq(principal.id, input.principalId),
    })
    if (!target) throw new NotFoundError('MEMBER_NOT_FOUND', 'Team member not found')
    if (input.requireTeamTarget && !isTeamMember(target.role)) {
      throw new NotFoundError('MEMBER_NOT_FOUND', 'Team member not found')
    }

    await assertRoleChangeAllowed(tx, target, input.newRole)

    const changed = target.role !== input.newRole
    if (changed) {
      await tx
        .update(principal)
        .set({ role: input.newRole })
        .where(eq(principal.id, input.principalId))
    }
    return {
      previousRole: target.role,
      newRole: input.newRole,
      userId: (target.userId as UserId | null) ?? null,
      changed,
    }
  })
}

export interface UserRoleChange {
  /** The role before the change; null when the principal was created. */
  previousRole: string | null
  newRole: Role
  principalId: PrincipalId
}

/**
 * When setUserTeamRole changes the role it was given:
 *
 * - `raise`: only when the new role ranks above the current one (invitation
 *   acceptance never lowers a role);
 * - `from_user`: only a principal whose role is still `user` (SSO
 *   auto-provisioning without `syncOnEverySignIn`);
 * - `set`: whatever the current role, a demotion included (SSO
 *   auto-provisioning with `syncOnEverySignIn`).
 */
export type UserRoleWriteMode = 'raise' | 'from_user' | 'set'

/**
 * Give a user's principal a role, under the team-role lock, for the writers
 * that address a user rather than a principal: SSO auto-provisioning
 * (handleAutoProvisionAfter in auth/hooks.ts) and invitation acceptance
 * (acceptInvitationFn in functions/invitations.ts).
 *
 * The principal is read inside the locked transaction, so the role another
 * writer set after the caller's own first read is the one `mode` and the rules
 * see. The rules are changeTeamRole's: a promotion needs an identity that
 * satisfies the team identity rule, and taking `admin` away needs another
 * eligible administrator.
 *
 * A missing principal counts as `user`. It is created with the role: a new
 * member, or a returning user whose principal "Remove from portal" deleted
 * (that keeps the auth user). `create` supplies its display name (the auth
 * user's name otherwise) and, for an SSO sign-in, `lastSsoSignInAt`.
 *
 * Returns the change, or null when nothing changed. Throws ForbiddenError
 * `TEAM_IDENTITY_REQUIRED` or `LAST_ADMIN` when a rule refuses.
 */
export async function setUserTeamRole(input: {
  userId: UserId
  newRole: Role
  mode: UserRoleWriteMode
  create?: { displayName?: string | null; lastSsoSignInAt?: Date | null }
}): Promise<UserRoleChange | null> {
  const { principal, user, eq } = await import('@/lib/server/db')
  return withTeamRoleLock(async (tx) => {
    const target = await tx.query.principal.findFirst({
      where: eq(principal.userId, input.userId),
    })
    const currentRole = target?.role ?? 'user'
    if (currentRole === input.newRole) return null
    if (input.mode === 'from_user' && currentRole !== 'user') return null
    if (input.mode === 'raise' && rankOf(input.newRole) <= rankOf(currentRole)) return null

    if (target) {
      await assertRoleChangeAllowed(tx, target, input.newRole)
      await tx.update(principal).set({ role: input.newRole }).where(eq(principal.id, target.id))
      return {
        previousRole: target.role,
        newRole: input.newRole,
        principalId: target.id as PrincipalId,
      }
    }

    // Reaching here means the new role is a team role: a missing principal
    // counts as `user`, and `user` to `user` returned above.
    await assertTeamRoleAssignable(input.userId, tx)
    const authUser = await tx.query.user.findFirst({
      where: eq(user.id, input.userId),
      columns: { name: true, image: true },
    })
    const principalId = generateId('principal')
    await tx.insert(principal).values({
      id: principalId,
      userId: input.userId,
      role: input.newRole,
      displayName: input.create?.displayName ?? authUser?.name ?? null,
      avatarUrl: authUser?.image ?? null,
      lastSsoSignInAt: input.create?.lastSsoSignInAt ?? null,
      createdAt: new Date(),
    })
    return { previousRole: null, newRole: input.newRole, principalId }
  })
}

export type DesignationSource = 'sign_in' | 'session'

export interface DesignationResult {
  previousRole: string
  newRole: Role
  reason: 'designated_admin_email' | 'team_invitation'
  invitationId: InviteId | null
}

/**
 * Apply the configured designation to a signed-in user.
 *
 * - An address in VENTURI_TEAM_ADMIN_EMAILS becomes `admin`.
 * - With `includeInvitations`, a pending team invitation for the address is
 *   accepted and grants its role (member or admin).
 *
 * Both need the team identity rule to hold; otherwise nothing changes. Only
 * ever raises a role. Returns the change, or null when nothing changed.
 */
export async function applyTeamDesignation(input: {
  userId: UserId
  email: string | null | undefined
  emailVerified?: boolean | null
  includeInvitations: boolean
  source: DesignationSource
  headers?: Headers
}): Promise<DesignationResult | null> {
  const designated = isDesignatedAdminEmail(input.email)
  if (!designated && !input.includeInvitations) return null
  // Every designation needs a team-domain address; skip the reads otherwise.
  if (!isTeamDomainEmail(input.email)) return null

  const known =
    input.emailVerified === undefined
      ? undefined
      : { email: input.email, emailVerified: input.emailVerified }
  // A first read outside the lock skips the transaction for an identity that
  // does not qualify (session-role.ts calls this on every request of a
  // designated address that is not yet admin).
  const preliminary = await loadTeamIdentity(input.userId, known)
  if (!preliminary || teamIdentityGap(preliminary) !== null) return null

  const email = String(input.email).trim().toLowerCase()
  const { principal, invitation, and, eq, gt, desc } = await import('@/lib/server/db')

  const outcome = await withTeamRoleLock(async (tx) => {
    // The rule is checked again under the lock, like every other rule check,
    // so an unlink that committed first is what decides.
    const identity = await loadTeamIdentity(input.userId, known, tx)
    if (!identity || teamIdentityGap(identity) !== null) return null

    const target = await tx.query.principal.findFirst({
      where: eq(principal.userId, input.userId),
    })
    if (!target || target.type !== 'user') return null

    let targetRole: Role | null = designated ? 'admin' : null
    let reason: DesignationResult['reason'] = 'designated_admin_email'
    let invite: { id: InviteId; role: string | null; magicLinkTokens: string[] } | null = null

    if (input.includeInvitations) {
      const pending = await tx.query.invitation.findFirst({
        where: and(
          eq(invitation.kind, 'team'),
          eq(invitation.status, 'pending'),
          eq(invitation.email, email),
          gt(invitation.expiresAt, new Date())
        ),
        orderBy: desc(invitation.createdAt),
      })
      if (pending) {
        invite = {
          id: pending.id as InviteId,
          role: pending.role,
          magicLinkTokens: pending.magicLinkTokens ?? [],
        }
        const inviteRole: Role = pending.role === 'admin' ? 'admin' : 'member'
        if (!targetRole || rankOf(inviteRole) > rankOf(targetRole)) {
          targetRole = inviteRole
          reason = 'team_invitation'
        }
      }
    }

    if (invite) {
      await tx
        .update(invitation)
        .set({ status: 'accepted' })
        .where(and(eq(invitation.id, invite.id), eq(invitation.status, 'pending')))
    }

    if (!targetRole || rankOf(targetRole) <= rankOf(target.role)) {
      return { change: null, invite }
    }

    await tx.update(principal).set({ role: targetRole }).where(eq(principal.id, target.id))
    return {
      change: {
        previousRole: target.role,
        newRole: targetRole,
        reason,
        invitationId: invite?.id ?? null,
        principalId: target.id as PrincipalId,
      },
      invite,
    }
  })

  if (!outcome) return null

  if (outcome.invite && outcome.invite.magicLinkTokens.length > 0) {
    try {
      const { revokeMagicLinkTokens } = await import('@/lib/server/auth/magic-link-mint')
      await revokeMagicLinkTokens(outcome.invite.magicLinkTokens)
    } catch (error) {
      log.error({ err: error }, 'invitation token revoke failed after designation')
    }
  }

  const change = outcome.change
  if (!change) return null

  const { cacheDel, CACHE_KEYS } = await import('@/lib/server/redis')
  await cacheDel(CACHE_KEYS.PRINCIPAL_BY_USER(input.userId))

  const { recordAuditEvent } = await import('@/lib/server/audit/log')
  await recordAuditEvent({
    event: 'user.role.changed',
    outcome: 'success',
    actor: { userId: input.userId, email, role: change.newRole, type: 'system' },
    headers: input.headers,
    target: { type: 'principal', id: change.principalId },
    before: { role: change.previousRole },
    after: { role: change.newRole },
    metadata: {
      source:
        change.reason === 'designated_admin_email' ? 'VENTURI_TEAM_ADMIN_EMAILS' : 'invitation',
      trigger: input.source,
      ...(change.invitationId ? { invitationId: change.invitationId } : {}),
    },
  })

  log.info(
    {
      principal_id: change.principalId,
      role: change.newRole,
      reason: change.reason,
      trigger: input.source,
    },
    'team designation applied'
  )

  return {
    previousRole: change.previousRole,
    newRole: change.newRole,
    reason: change.reason,
    invitationId: change.invitationId,
  }
}
