/**
 * PrincipalService - Business logic for principals
 *
 * Provides principal lookup operations.
 */

import {
  db,
  eq,
  ne,
  and,
  or,
  sql,
  ilike,
  max,
  principal,
  session,
  user,
  type Principal,
} from '@/lib/server/db'
import type { ServiceMetadata } from '@/lib/server/db'
import type { PrincipalId, UserId } from '@quackback/ids'
import { InternalError, ForbiddenError, NotFoundError } from '@/lib/shared/errors'
import { cacheDel, CACHE_KEYS } from '@/lib/server/redis'
import { recordAuditEvent, type AuditActor } from '@/lib/server/audit/log'
import type { TeamMember } from './principal.types'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'principals' })

// Re-export types for backwards compatibility
export type { TeamMember } from './principal.types'

/**
 * Find a principal by user ID
 */
export async function getMemberByUser(userId: UserId): Promise<Principal | null> {
  try {
    const foundMember = await db.query.principal.findFirst({
      where: eq(principal.userId, userId),
    })
    return foundMember ?? null
  } catch (error) {
    log.error({ err: error }, 'principal lookup failed')
    throw new InternalError('DATABASE_ERROR', 'Failed to lookup principal', error)
  }
}

/**
 * Find a principal by ID
 */
export async function getMemberById(principalId: PrincipalId): Promise<Principal | null> {
  try {
    const foundMember = await db.query.principal.findFirst({
      where: eq(principal.id, principalId),
    })
    return foundMember ?? null
  } catch (error) {
    log.error({ err: error }, 'principal lookup failed')
    throw new InternalError('DATABASE_ERROR', 'Failed to lookup principal', error)
  }
}

/**
 * Create a service principal (for API keys or integrations)
 */
export async function createServicePrincipal(params: {
  role: 'admin' | 'member'
  displayName: string
  serviceMetadata: ServiceMetadata
}): Promise<Principal> {
  const [created] = await db
    .insert(principal)
    .values({
      userId: null,
      type: 'service',
      role: params.role,
      displayName: params.displayName,
      serviceMetadata: params.serviceMetadata,
      createdAt: new Date(),
    })
    .returning()

  return created
}

/**
 * Sync profile fields from user table to their principal record.
 * Called when a user changes their name or avatar.
 */
export async function syncPrincipalProfile(
  userId: UserId,
  updates: {
    displayName?: string
    avatarUrl?: string | null
    avatarKey?: string | null
  }
): Promise<void> {
  await db
    .update(principal)
    .set(updates)
    .where(and(eq(principal.userId, userId), eq(principal.type, 'user')))
}

/**
 * List all team members with user details
 *
 * `lastSignInAt` is computed as `max(session.created_at)` per user
 * via a left-join subquery so the admin team list can show a
 * "last sign-in" column without a second round-trip. Users with no
 * sessions show `null` (never signed in or all sessions pruned).
 */
export async function listTeamMembers(): Promise<TeamMember[]> {
  try {
    // Subquery: latest session timestamp per user. Left-joined so
    // users without sessions still appear in the result with null.
    const lastSession = db
      .select({
        userId: session.userId,
        lastSignInAt: max(session.createdAt).as('last_sign_in_at'),
      })
      .from(session)
      .groupBy(session.userId)
      .as('last_session')

    const rawMembers = await db
      .select({
        id: principal.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: principal.role,
        createdAt: principal.createdAt,
        lastSignInAt: sql<Date | string | null>`${lastSession.lastSignInAt}`,
      })
      .from(principal)
      .innerJoin(user, eq(principal.userId, user.id))
      .leftJoin(lastSession, eq(lastSession.userId, user.id))
      .where(eq(principal.type, 'user'))

    // The `max()` aggregate comes back as a string from postgres-js
    // (Date mapping only fires on plain timestamp column selects);
    // normalise to Date for the TeamMember type. Different shape from
    // the server-fn boundary (which wants string), so we use a Date
    // constructor directly rather than going through toIsoStringOrNull.
    return rawMembers.map((m) => ({
      ...m,
      lastSignInAt: m.lastSignInAt == null ? null : new Date(m.lastSignInAt),
    }))
  } catch (error) {
    log.error({ err: error }, 'failed to list team members')
    throw new InternalError('DATABASE_ERROR', 'Failed to list team members', error)
  }
}

/**
 * Search members (all human principals) by name or email.
 * Returns a limited result set for use in typeahead/combobox components.
 */
export async function searchMembers(params: {
  search?: string
  limit?: number
}): Promise<TeamMember[]> {
  const limit = Math.min(params.limit ?? 20, 50)
  const conditions = [eq(principal.type, 'user')]

  if (params.search?.trim()) {
    const q = `%${params.search.trim()}%`
    conditions.push(or(ilike(user.name, q), ilike(user.email, q))!)
  }

  return db
    .select({
      id: principal.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: principal.role,
      createdAt: principal.createdAt,
      // searchMembers is the typeahead path — never displays
      // last-sign-in, so a null literal is cheaper than the
      // group-by needed in listTeamMembers.
      lastSignInAt: sql<Date | null>`NULL::timestamptz`,
    })
    .from(principal)
    .innerJoin(user, eq(principal.userId, user.id))
    .where(and(...conditions))
    .orderBy(user.name)
    .limit(limit)
}

/**
 * Count all principals excluding anonymous voters (no auth required)
 */
export async function countMembers(): Promise<number> {
  try {
    const result = await db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(principal)
      .where(ne(principal.type, 'anonymous'))

    return Number(result[0]?.count ?? 0)
  } catch (error) {
    log.error({ err: error }, 'failed to count principals')
    throw new InternalError('DATABASE_ERROR', 'Failed to count principals', error)
  }
}

/**
 * Update a team member's role
 *
 * Runs under the team-role lock (team-designation.ts): a promotion to admin
 * needs an identity that satisfies the team identity rule, and a demotion
 * needs another eligible human administrator to remain.
 * @throws ForbiddenError if trying to modify own role
 * @throws ForbiddenError if this would leave no eligible admin
 * @throws ForbiddenError TEAM_IDENTITY_REQUIRED if the promotion's identity does not qualify
 * @throws NotFoundError if principal not found or not a team member
 */
export async function updateMemberRole(
  principalId: PrincipalId,
  newRole: 'admin' | 'member',
  actingPrincipalId: PrincipalId,
  actor: AuditActor | null = null,
  headers?: Headers
): Promise<void> {
  try {
    const { changeTeamRole } = await import('./team-designation')
    const result = await changeTeamRole({
      principalId,
      newRole,
      actingPrincipalId,
      requireTeamTarget: true,
    })

    if (result.userId) {
      await cacheDel(CACHE_KEYS.PRINCIPAL_BY_USER(result.userId))
    }

    // Audit the role change. Already audited from the SSO/JIT path
    // (`auth/hooks.ts` emits user.role.changed there). Admin manual
    // role flips need the same coverage or the audit log doesn't tell
    // the full story of who got which role.
    if (actor) {
      await recordAuditEvent({
        event: 'user.role.changed',
        actor,
        headers,
        target: { type: 'principal', id: principalId },
        before: { role: result.previousRole },
        after: { role: newRole },
      })
    }
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) {
      throw error
    }
    log.error({ err: error }, 'failed to update principal role')
    throw new InternalError('DATABASE_ERROR', 'Failed to update principal role', error)
  }
}

/**
 * Give an existing account a team role (Admin > Team designation).
 *
 * The target is a person who already signed in; the server refuses anyone
 * whose identity does not satisfy the team identity rule. Also used to move a
 * team member between member and admin.
 */
export async function designateTeamMember(
  principalId: PrincipalId,
  newRole: 'admin' | 'member',
  actingPrincipalId: PrincipalId,
  actor: AuditActor | null = null,
  headers?: Headers
): Promise<{ previousRole: string; newRole: 'admin' | 'member' }> {
  try {
    const { changeTeamRole } = await import('./team-designation')
    const result = await changeTeamRole({
      principalId,
      newRole,
      actingPrincipalId,
      requireTeamTarget: false,
    })

    if (result.userId) {
      await cacheDel(CACHE_KEYS.PRINCIPAL_BY_USER(result.userId))
    }

    if (actor && result.changed) {
      await recordAuditEvent({
        event: 'user.role.changed',
        actor,
        headers,
        target: { type: 'principal', id: principalId },
        before: { role: result.previousRole },
        after: { role: newRole },
        metadata: { source: 'admin_team_designation' },
      })
    }
    return { previousRole: result.previousRole, newRole }
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) {
      throw error
    }
    log.error({ err: error }, 'failed to designate team member')
    throw new InternalError('DATABASE_ERROR', 'Failed to designate team member', error)
  }
}

/**
 * Remove a team member (converts them to a portal user)
 *
 * Runs under the team-role lock: removing an administrator needs another
 * eligible human administrator to remain.
 * @throws ForbiddenError if trying to remove self
 * @throws ForbiddenError if this would leave no eligible admin
 * @throws NotFoundError if principal not found or not a team member
 */
export async function removeTeamMember(
  principalId: PrincipalId,
  actingPrincipalId: PrincipalId,
  actor: AuditActor | null = null,
  headers?: Headers
): Promise<void> {
  try {
    const { changeTeamRole } = await import('./team-designation')
    const result = await changeTeamRole({
      principalId,
      newRole: 'user',
      actingPrincipalId,
      requireTeamTarget: true,
    })

    if (result.userId) {
      await cacheDel(CACHE_KEYS.PRINCIPAL_BY_USER(result.userId))
    }

    // Audit the removal. The audit-event taxonomy already reserves
    // `user.removed` for this exact action (audit/log.ts); without an
    // emission the event was a dead literal and the team can't see
    // who lost which role.
    if (actor) {
      await recordAuditEvent({
        event: 'user.removed',
        actor,
        headers,
        target: { type: 'principal', id: principalId },
        before: { role: result.previousRole },
        after: { role: 'user' },
      })
    }
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) {
      throw error
    }
    log.error({ err: error }, 'failed to remove team member')
    throw new InternalError('DATABASE_ERROR', 'Failed to remove team member', error)
  }
}
