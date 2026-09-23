/**
 * Server functions for workspace data fetching.
 */

import { createServerFn, createServerOnlyFn } from '@tanstack/react-start'
import { db, principal, eq } from '@/lib/server/db'
import { getSession } from '@/lib/server/auth/session'
import { effectiveRole } from '@/lib/shared/roles'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'workspace' })

/**
 * Get the app settings.
 *
 * Returns the RAW settings row: JSON config columns (featureFlags, authConfig,
 * portalConfig, ...) come back as unparsed text. For parsed, default-merged
 * reads use the settings domain service (getTenantSettings / isFeatureEnabled)
 * instead of casting a column off this row.
 *
 * Server-only. The raw row carries server-only policy (portal allowlists,
 * tier limits) and the widget HMAC secret, so it must never be reachable as
 * a public `/_serverFn` RPC. Client-side code reads the redacted tenant
 * settings from the router context instead.
 */
export const getSettings = createServerOnlyFn(async () => {
  try {
    const org = await db.query.settings.findFirst()
    return org ?? null
  } catch (error) {
    log.error({ err: error }, 'get settings failed')
    throw error
  }
})

/**
 * Get current user's role if logged in
 */
export const getCurrentUserRole = createServerFn({ method: 'GET' }).handler(
  async (): Promise<'admin' | 'member' | 'user' | null> => {
    log.debug('get current user role')
    try {
      const session = await getSession()
      if (!session?.user) {
        log.debug('no session')
        return null
      }

      const principalRecord = await db.query.principal.findFirst({
        where: eq(principal.userId, session.user.id),
      })

      if (!principalRecord) {
        log.debug('no principal')
        return null
      }
      const role = effectiveRole(principalRecord.role, principalRecord.type) ?? 'user'
      log.debug({ role }, 'current user role')
      return role
    } catch (error) {
      log.error({ err: error }, 'get current user role failed')
      throw error
    }
  }
)

/**
 * Validate API workspace access.
 *
 * Server-only: used by the /api/import and /api/export server routes. It
 * returns the raw settings row, so it must not be exposed as an RPC.
 */
export const validateApiWorkspaceAccess = createServerOnlyFn(async () => {
  try {
    const session = await getSession()
    if (!session?.user) {
      return { success: false as const, error: 'Unauthorized', status: 401 as const }
    }

    const [principalRecord, appSettings] = await Promise.all([
      db.query.principal.findFirst({
        where: eq(principal.userId, session.user.id),
      }),
      db.query.settings.findFirst(),
    ])

    if (!principalRecord) {
      return { success: false as const, error: 'Forbidden', status: 403 as const }
    }

    if (!appSettings) {
      return { success: false as const, error: 'Settings not found', status: 403 as const }
    }

    return {
      success: true as const,
      settings: appSettings,
      // Callers gate on principal.role; a team role only counts on a human
      // principal (see effectiveRole), so cap it before returning.
      principal: {
        ...principalRecord,
        role: effectiveRole(principalRecord.role, principalRecord.type) ?? 'user',
      },
      user: session.user,
    }
  } catch (error) {
    log.error({ err: error }, 'validate api workspace access failed')
    throw error
  }
})

export type ApiWorkspaceResult = Awaited<ReturnType<typeof validateApiWorkspaceAccess>>
