/**
 * Workspace auth for route loaders (beforeLoad).
 *
 * These throw redirect() for unauthenticated users, making them suitable
 * for route guards. For server functions, use requireAuth() from auth-helpers.ts.
 */

import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import { z } from 'zod'
import type { UserId } from '@quackback/ids'
import { getSession } from '@/lib/server/auth/session'
import { db, principal, eq } from '@/lib/server/db'
import { effectiveRole, isTeamMember } from '@/lib/shared/roles'
import { logger } from '@/lib/server/logger'
import { buildSigninRedirect } from '@/lib/shared/auth-prompt'

const log = logger.child({ component: 'workspace-utils' })

const requireWorkspaceRoleSchema = z.object({
  allowedRoles: z.array(z.string()),
})

/**
 * Route guard: require authenticated user with specific workspace role.
 * Unauthenticated callers on team-only routes are sent to the portal
 * sign-in dialog with `callbackUrl=/admin`. Callers on routes that also
 * allow role='user' (public portal) fall back to '/'.
 *
 * Use in route beforeLoad:
 * @example
 * beforeLoad: async () => {
 *   const { user, member } = await requireWorkspaceRole({
 *     data: { allowedRoles: ['admin', 'member'] }
 *   })
 *   return { user, member }
 * }
 */
export const requireWorkspaceRole = createServerFn({ method: 'GET' })
  .validator(requireWorkspaceRoleSchema)
  .handler(async ({ data }) => {
    log.debug({ allowed_roles: data.allowedRoles }, 'require workspace role')
    // Team-only routes send unauthenticated callers to the sign-in dialog
    // with a /admin callback. Routes that also allow role='user' (public
    // portal) fall back to '/' for the regular sign-in flow.
    const teamOnly = data.allowedRoles.every(isTeamMember)
    const unauthRedirect = teamOnly ? buildSigninRedirect('/admin') : { to: '/' as const }
    try {
      const session = await getSession()
      if (!session?.user) {
        throw redirect(unauthRedirect)
      }

      const appSettings = await db.query.settings.findFirst()
      if (!appSettings) {
        throw redirect({ to: '/' })
      }

      // Note: Onboarding check is handled in __root.tsx beforeLoad

      const principalRecord = await db.query.principal.findFirst({
        where: eq(principal.userId, session.user.id as UserId),
      })
      if (!principalRecord) {
        throw redirect(unauthRedirect)
      }

      // A team role only counts on a human principal: an anonymous or service
      // principal carrying admin/member is treated as a portal user here too,
      // matching requireAuth, so the admin shell never renders for it.
      const role = effectiveRole(principalRecord.role, principalRecord.type) ?? 'user'
      if (!data.allowedRoles.includes(role)) {
        // A team member on an administrator-only page is already signed in with
        // the right account, so the portal sign-in dialog would be the wrong
        // answer. Send them to the settings landing page, which renders a
        // durable "Administrators only" state. Everyone else lacks team access.
        if (isTeamMember(role)) {
          throw redirect({ to: '/admin/settings', search: { error: 'not_admin' } })
        }
        throw redirect(buildSigninRedirect('/admin', { error: 'not_team_member' }))
      }

      return {
        settings: appSettings,
        principal: { ...principalRecord, role },
        user: session.user,
      }
    } catch (error) {
      log.error({ err: error }, 'require workspace role failed')
      throw error
    }
  })
