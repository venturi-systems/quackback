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
import { isTeamMember } from '@/lib/shared/roles'
import { resolveSessionRole } from '@/lib/server/domains/principals/session-role'
import { logger } from '@/lib/server/logger'
import { buildSigninRedirect } from '@/lib/shared/auth-prompt'
import { teamSigninCallback } from '@/lib/shared/routing'

const log = logger.child({ component: 'workspace-utils' })

const requireWorkspaceRoleSchema = z.object({
  allowedRoles: z.array(z.string()),
  /**
   * The team page the caller asked for (path, query and fragment), so a
   * sign-in sends them back to it rather than to the admin home. Kept only
   * when it is a same-origin team path; anything else falls back to `/admin`.
   */
  callbackUrl: z.string().optional(),
})

/**
 * Route guard: require authenticated user with specific workspace role.
 * Unauthenticated callers on team-only routes are sent to the portal
 * sign-in dialog with the team page they asked for as `callbackUrl`
 * (`/admin` when none was passed). Callers on routes that also allow
 * role='user' (public portal) fall back to '/'.
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
    // with the requested team page (or /admin) as the callback. Routes that
    // also allow role='user' (public portal) fall back to '/' for the
    // regular sign-in flow.
    const teamOnly = data.allowedRoles.every(isTeamMember)
    const callbackUrl = teamSigninCallback(data.callbackUrl)
    const unauthRedirect = teamOnly ? buildSigninRedirect(callbackUrl) : { to: '/' as const }
    try {
      const session = await getSession()
      if (!session?.user) {
        throw redirect(unauthRedirect)
      }

      // This is a client-callable route guard. Only check workspace existence;
      // raw settings include signing secrets and portal allowlists.
      const appSettings = await db.query.settings.findFirst({ columns: { id: true } })
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

      // One resolver with requireAuth: an anonymous or service principal
      // carrying admin/member is a portal user, a stored team role counts only
      // while the identity satisfies the team identity rule, and a designated
      // address (VENTURI_TEAM_ADMIN_EMAILS) is promoted here on its next
      // request, so the admin shell renders exactly when requireAuth agrees.
      const role = await resolveSessionRole(principalRecord, session.user)
      if (!data.allowedRoles.includes(role)) {
        // A team member on an administrator-only page is already signed in with
        // the right account, so the portal sign-in dialog would be the wrong
        // answer. Send them to the settings landing page, which renders a
        // durable "Administrators only" state. Everyone else lacks team access.
        if (isTeamMember(role)) {
          throw redirect({ to: '/admin/settings', search: { error: 'not_admin' } })
        }
        // A stored team role this identity cannot exercise (for example a
        // password-only account, or an address outside the team domains)
        // gets the reason instead of the generic "not a team member".
        const error =
          principalRecord.type === 'user' && isTeamMember(principalRecord.role)
            ? 'team_identity_required'
            : 'not_team_member'
        throw redirect(buildSigninRedirect(callbackUrl, { error }))
      }

      return {
        principal: { ...principalRecord, role },
        user: session.user,
      }
    } catch (error) {
      log.error({ err: error }, 'require workspace role failed')
      throw error
    }
  })
