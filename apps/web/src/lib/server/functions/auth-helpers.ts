/**
 * Auth helper functions for server functions.
 *
 * These provide role-based authentication checks for use in server function handlers.
 */

import type { UserId, PrincipalId, WorkspaceId } from '@quackback/ids'
import { generateId } from '@quackback/ids'
import type { Role } from '@/lib/server/auth'
import { auth } from '@/lib/server/auth'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { getSettings } from './workspace'
import { db, principal, eq } from '@/lib/server/db'
import { effectiveRole } from '@/lib/shared/roles'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'auth-helpers' })

// Type alias for session result
type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>

/**
 * Quick check if the request has a session cookie.
 * This allows early bailout for anonymous users WITHOUT hitting the database.
 * Use this before calling getOptionalAuth() for endpoints that return
 * default/empty data for anonymous users.
 */
export function hasSessionCookie(): boolean {
  const headers = getRequestHeaders()
  const cookie = headers.get('cookie') ?? ''
  return cookie.includes('better-auth.session_token')
}

/**
 * Check if the request has any form of authentication (cookie or Bearer token).
 * Use this instead of hasSessionCookie() when the endpoint should support
 * both portal (cookie) and widget (Bearer token) authentication.
 */
export function hasAuthCredentials(): boolean {
  const headers = getRequestHeaders()
  const cookie = headers.get('cookie') ?? ''
  const auth = headers.get('authorization') ?? ''
  return cookie.includes('better-auth.session_token') || auth.startsWith('Bearer ')
}

/**
 * Get session directly from better-auth (not through server function).
 * This avoids nested server function call issues.
 */
async function getSessionDirect(): Promise<SessionResult | null> {
  try {
    return await auth.api.getSession({ headers: getRequestHeaders() })
  } catch (error) {
    log.error({ err: error }, 'get session failed')
    return null
  }
}

export type { Role }

/**
 * Role a session principal may exercise. A team role held by a non-human
 * principal (anonymous or service) is capped at 'user' and logged, because
 * that state only arises from a privilege-escalation path and must never
 * grant team access.
 */
function resolveEffectiveRole(record: { id: string; role: string; type: string }): Role {
  const role = effectiveRole(record.role, record.type) ?? 'user'
  if (role !== record.role) {
    log.warn(
      { principal_id: record.id, stored_role: record.role, principal_type: record.type },
      'team role on a non-human principal ignored'
    )
  }
  return role
}

export interface AuthContext {
  settings: {
    id: WorkspaceId
    slug: string
    name: string
    logoKey: string | null
  }
  user: {
    id: UserId
    email: string
    name: string
    image: string | null
  }
  principal: {
    id: PrincipalId
    role: Role
    type: string
  }
}

/**
 * Require authentication with optional role check.
 * Throws if user is not authenticated or doesn't have required role.
 *
 * @example
 * // Require any team member
 * const auth = await requireAuth({ roles: ['admin', 'member'] })
 *
 * // Require admin only
 * const auth = await requireAuth({ roles: ['admin'] })
 *
 * // Just require authentication (any role)
 * const auth = await requireAuth()
 */
export async function requireAuth(options?: { roles?: Role[] }): Promise<AuthContext> {
  log.debug({ roles: options?.roles }, 'require auth')
  try {
    const session = await getSessionDirect()
    if (!session?.user) {
      throw new Error('Authentication required')
    }
    const userId = session.user.id as UserId

    const appSettings = await getSettings()
    if (!appSettings) {
      throw new Error('Workspace not configured')
    }

    const principalRecord = await db.query.principal.findFirst({
      where: eq(principal.userId, userId),
    })

    if (!principalRecord) {
      throw new Error('Access denied: Not a team member')
    }

    // Only a human principal may exercise a team role. An anonymous or
    // service principal that carries admin/member is treated as a portal
    // user, so it fails every team-role check below.
    const role = resolveEffectiveRole(principalRecord)

    if (options?.roles && !options.roles.includes(role)) {
      throw new Error(`Access denied: Requires [${options.roles.join(', ')}], got ${role}`)
    }

    return {
      settings: {
        id: appSettings.id as WorkspaceId,
        slug: appSettings.slug,
        name: appSettings.name,
        logoKey: appSettings.logoKey ?? null,
      },
      user: {
        id: userId,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? null,
      },
      principal: {
        id: principalRecord.id as PrincipalId,
        role,
        type: principalRecord.type,
      },
    }
  } catch (error) {
    log.error({ err: error }, 'require auth failed')
    throw error
  }
}

/**
 * Get auth context if authenticated, null otherwise.
 * Useful for public endpoints that behave differently for logged-in users.
 *
 * Auto-creates a member record with role 'user' for authenticated users
 * who don't have one (e.g., users who signed up via OTP).
 */
export async function getOptionalAuth(): Promise<AuthContext | null> {
  log.debug('get optional auth')
  try {
    const session = await getSessionDirect()
    if (!session?.user) {
      return null
    }
    const userId = session.user.id as UserId

    const appSettings = await getSettings()
    if (!appSettings) {
      return null
    }

    let principalRecord = await db.query.principal.findFirst({
      where: eq(principal.userId, userId),
    })

    // Auto-create principal record for authenticated users without one
    if (!principalRecord) {
      const newPrincipalId = generateId('principal')
      const [created] = await db
        .insert(principal)
        .values({
          id: newPrincipalId,
          userId,
          role: 'user',
          displayName: session.user.name,
          avatarUrl: session.user.image ?? null,
          createdAt: new Date(),
        })
        .returning()
      principalRecord = created
    }

    return {
      settings: {
        id: appSettings.id as WorkspaceId,
        slug: appSettings.slug,
        name: appSettings.name,
        logoKey: appSettings.logoKey ?? null,
      },
      user: {
        id: userId,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? null,
      },
      principal: {
        id: principalRecord.id as PrincipalId,
        role: resolveEffectiveRole(principalRecord),
        type: principalRecord.type,
      },
    }
  } catch (error) {
    log.error({ err: error }, 'get optional auth failed')
    throw error
  }
}

// ============================================================================
// Policy actor resolution
// ============================================================================

import type { Actor, PrincipalType } from '@/lib/server/policy/types'
import { ANONYMOUS_ACTOR } from '@/lib/server/policy/types'
import { segmentIdsForPrincipal } from '@/lib/server/domains/segments/segment-membership.service'

/**
 * Preserve all three principal types. Collapsing 'anonymous' onto 'user'
 * is a security bug: a Better Auth anonymous session would satisfy
 * audience.kind='authenticated' and dodge the workspace requireApproval='anonymous'
 * moderation gate.
 */
export function normalizePrincipalType(raw: string | null | undefined): PrincipalType {
  if (raw === 'service') return 'service'
  if (raw === 'anonymous') return 'anonymous'
  return 'user'
}

/**
 * Build a policy Actor from an AuthContext. Resolves segment memberships
 * via segmentIdsForPrincipal. Returns ANONYMOUS_ACTOR for null auth.
 *
 * NOTE: this is the policy-shaped actor. The audit-log helper has a
 * separate, synchronous `actorFromAuth` returning the {userId, email,
 * role} shape — do not confuse them. See audit/log.ts.
 */
export async function policyActorFromAuth(auth: AuthContext | null): Promise<Actor> {
  if (!auth) return ANONYMOUS_ACTOR
  const segmentIds = await segmentIdsForPrincipal(auth.principal.id)
  return {
    principalId: auth.principal.id,
    role: auth.principal.role,
    principalType: normalizePrincipalType(auth.principal.type),
    segmentIds,
  }
}
