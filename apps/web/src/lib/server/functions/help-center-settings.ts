/**
 * Server Functions for Help Center Settings
 */

import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireAuth } from './auth-helpers'
import {
  getHelpCenterConfig,
  updateHelpCenterConfig,
} from '@/lib/server/domains/settings/settings.service'
import {
  updateHelpCenterConfigSchema,
  updateHelpCenterSeoSchema,
} from '@/lib/shared/schemas/help-center'

// ============================================================================
// Help Center Config Server Functions
// ============================================================================

export const getHelpCenterConfigFn = createServerFn({ method: 'GET' })
  .validator(z.object({}))
  .handler(async () => {
    await requireAuth({ roles: ['admin'] })
    return getHelpCenterConfig()
  })

export const updateHelpCenterConfigFn = createServerFn({ method: 'POST' })
  .validator(updateHelpCenterConfigSchema)
  .handler(async ({ data }) => {
    const auth = await requireAuth({ roles: ['admin'] })
    const before = await getHelpCenterConfig().catch(() => null)
    // Enabling the public Help Center falls under the same policy lock as the
    // feature flag (POLICY_MANAGED_SETTINGS `features.helpCenter`).
    const nextEnabled = (data as { enabled?: boolean }).enabled
    if (nextEnabled !== undefined && nextEnabled !== (before?.enabled ?? false)) {
      const { assertNotManaged } = await import('@/lib/server/config-file/managed-guard')
      await assertNotManaged('features.helpCenter')
    }
    const result = await updateHelpCenterConfig(data)
    const { recordAuditSafely, sessionAuditActor } = await import('@/lib/server/audit/audit-safe')
    await recordAuditSafely(
      {
        event: 'settings.changed',
        actor: sessionAuditActor(auth),
        target: { type: 'settings', id: 'help_center' },
        before,
        after: data,
        metadata: { section: 'help_center' },
      },
      'request'
    )
    return result
  })

export const updateHelpCenterSeoFn = createServerFn({ method: 'POST' })
  .validator(updateHelpCenterSeoSchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin'] })
    const current = await getHelpCenterConfig()
    return updateHelpCenterConfig({
      seo: { ...current.seo, ...data },
    })
  })
