import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireAuth } from './auth-helpers'
import { updateFeatureFlags } from '@/lib/server/domains/settings/settings.service'
import type { FeatureFlags } from '@/lib/server/domains/settings/settings.types'

// Admin-only: feature flags toggle whole subsystems that change the
// public surface (helpCenter exposes a public subdomain) and the data
// flow (aiFeedbackExtraction routes customer text through an LLM).
// Without a role gate any unauthenticated RPC caller could flip these.
export const updateFeatureFlagsFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      helpCenter: z.boolean().optional(),
      aiFeedbackExtraction: z.boolean().optional(),
      supportInbox: z.boolean().optional(),
      linkPreviews: z.boolean().optional(),
    })
  )
  .handler(async ({ data }): Promise<FeatureFlags> => {
    const auth = await requireAuth({ roles: ['admin'] })
    const { getFeatureFlags } = await import('@/lib/server/domains/settings/settings.service')
    const before = await getFeatureFlags().catch(() => null)
    // The Help Center may be held off by policy (POLICY_MANAGED_SETTINGS
    // `features.helpCenter`): Venturi keeps it off and links the portal to
    // docs.venturi.systems instead. Refuse a change rather than save one the
    // policy forbids; a save that keeps the current value passes.
    if (data.helpCenter !== undefined && data.helpCenter !== (before?.helpCenter ?? false)) {
      const { assertNotManaged } = await import('@/lib/server/config-file/managed-guard')
      await assertNotManaged('features.helpCenter')
    }
    const result = await updateFeatureFlags(data)
    const { recordAuditSafely, sessionAuditActor } = await import('@/lib/server/audit/audit-safe')
    await recordAuditSafely(
      {
        event: 'settings.changed',
        actor: sessionAuditActor(auth),
        target: { type: 'settings', id: 'feature_flags' },
        before,
        after: data,
        metadata: { section: 'feature_flags' },
      },
      'request'
    )
    return result
  })
