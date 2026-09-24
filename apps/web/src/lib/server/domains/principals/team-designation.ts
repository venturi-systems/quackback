/**
 * Team designation: every write that gives, changes or removes a team role.
 *
 * Three rules hold here, for every writer (Admin > Team, invitations, the
 * VENTURI_TEAM_ADMIN_EMAILS promotion, onboarding and SSO provisioning):
 *
 *  - A promotion to member or admin needs an identity that satisfies the
 *    team identity rule (team-identity.ts). The server refuses anything else.
 *  - A change never leaves the workspace without a human administrator whose
 *    identity satisfies that rule. The check and the write run in one
 *    transaction under one advisory lock, so two concurrent demotions cannot
 *    each see the other as the remaining administrator.
 *  - Nobody changes or removes their own team role.
 *
 * Promotion from VENTURI_TEAM_ADMIN_EMAILS happens at a qualifying Google or
 * GitHub sign-in and at the next authenticated request of an existing
 * session. The list only promotes; demotion is always a person's act.
 */

import type { InviteId, PrincipalId, UserId } from '@quackback/ids'
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

const log = logger.child({ component: 'team-designation' })

/** Advisory-lock key every team-role writer takes. Stable across pods. */
export const TEAM_ROLE_LOCK_KEY = 'quackback:team_roles'

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
  const { db, sql } = await import('@/lib/server/db')
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${TEAM_ROLE_LOCK_KEY}))`)
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

    if (rankOf(input.newRole) > rankOf(target.role)) {
      if (target.type !== 'user') {
        throw new ForbiddenError(
          'TEAM_IDENTITY_REQUIRED',
          'Only a person can hold a team role. Service and anonymous principals cannot.'
        )
      }
      await assertTeamRoleAssignable(target.userId as UserId | null, tx)
    }

    if (isAdmin(target.role) && input.newRole !== 'admin' && target.type === 'user') {
      const remaining = await countEligibleAdmins(tx, target.id as PrincipalId)
      if (remaining < 1) {
        throw new ForbiddenError(
          'LAST_ADMIN',
          input.newRole === 'user' ? 'Cannot remove the last admin' : 'Cannot demote the last admin'
        )
      }
    }

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
  const identity = await loadTeamIdentity(input.userId, known)
  if (!identity || teamIdentityGap(identity) !== null) return null

  const email = String(input.email).trim().toLowerCase()
  const { principal, invitation, and, eq, gt, desc } = await import('@/lib/server/db')

  const outcome = await withTeamRoleLock(async (tx) => {
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
