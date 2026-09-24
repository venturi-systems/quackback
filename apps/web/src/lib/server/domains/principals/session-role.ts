/**
 * The one resolver for "which role may this signed-in person exercise".
 *
 * Every path that turns a session into an authority decision calls it:
 * requireAuth and getOptionalAuth (server functions), the admin route guard,
 * the SSR bootstrap, the workspace helpers, widget sessions, uploads and MCP
 * OAuth tokens. Keeping the rule in one place is what keeps it consistent.
 */

import type { UserId } from '@quackback/ids'
import { effectiveRole, isTeamMember, type Role } from '@/lib/shared/roles'
import { isDesignatedAdminEmail, loadTeamIdentity, resolveTeamRole } from './team-identity'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'session-role' })

export interface SessionPrincipal {
  id?: string
  role: string
  type?: string | null
  userId?: string | null
}

export interface SessionUserFacts {
  id: string
  email?: string | null
  emailVerified?: boolean | null
}

/**
 * Role a session principal may exercise.
 *
 * 1. A team role held by a non-human principal (anonymous or service) is
 *    capped at 'user' and logged: that state only arises from a
 *    privilege-escalation path and must never grant team access.
 * 2. A human principal whose address VENTURI_TEAM_ADMIN_EMAILS designates is
 *    promoted to admin here, on the next authenticated request of an existing
 *    session, when its identity satisfies the team identity rule. Sign-in does
 *    the same through the auth hooks (team-designation.ts).
 * 3. A stored team role counts only while the account's identity satisfies
 *    the team identity rule: a verified address at a team domain, from a
 *    linked Google or GitHub account (team-identity.ts).
 */
export async function resolveSessionRole(
  record: SessionPrincipal,
  sessionUser: SessionUserFacts,
  headers?: Headers
): Promise<Role> {
  const type = record.type ?? 'user'
  const capped = effectiveRole(record.role, type) ?? 'user'
  if (capped !== record.role) {
    log.warn(
      { principal_id: record.id ?? null, stored_role: record.role, principal_type: type },
      'team role on a non-human principal ignored'
    )
    return capped
  }

  let storedRole = record.role
  if (type === 'user' && storedRole !== 'admin' && isDesignatedAdminEmail(sessionUser.email)) {
    try {
      const { applyTeamDesignation } = await import('./team-designation')
      const applied = await applyTeamDesignation({
        userId: sessionUser.id as UserId,
        email: sessionUser.email,
        emailVerified: sessionUser.emailVerified ?? false,
        includeInvitations: false,
        source: 'session',
        headers,
      })
      if (applied) storedRole = applied.newRole
    } catch (error) {
      log.error({ err: error, user_id: sessionUser.id }, 'team designation on request failed')
    }
  }

  if (!isTeamMember(storedRole)) return effectiveRole(storedRole, type) ?? 'user'
  const identity = await loadTeamIdentity(sessionUser.id as UserId, {
    email: sessionUser.email,
    emailVerified: sessionUser.emailVerified ?? false,
  })
  // The session's user is the principal's user; fill it in for callers that
  // selected only the role columns.
  return resolveTeamRole(
    {
      id: record.id ?? sessionUser.id,
      type,
      role: storedRole,
      userId: record.userId ?? sessionUser.id,
    },
    identity
  )
}
