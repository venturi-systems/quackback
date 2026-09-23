import { ForbiddenError } from '@/lib/shared/errors'
import { config } from '@/lib/server/config'
import { isPathManaged } from './managed-paths'

/**
 * Throw 403 (ForbiddenError, code FIELD_MANAGED) if `path` is in the
 * workspace's managed-fields list.
 *
 * Threaded through every settings mutator that owns a managed-eligible
 * field. The managed-paths read goes via getTenantSettings() so the
 * Redis cache backing it absorbs the per-mutator cost.
 */
export async function assertNotManaged(path: string): Promise<void> {
  const { getTenantSettings } = await import('@/lib/server/domains/settings/settings.service')
  await _internalAssertNotManaged(path, async () => {
    const s = await getTenantSettings()
    return withPolicyManagedPaths(s?.managedFieldPaths ?? [])
  })
}

/**
 * Every managed path: the config-file list stored on the settings row plus
 * the paths an external policy process owns (POLICY_MANAGED_SETTINGS). Read at
 * call time, never cached with the settings row, so an environment change
 * takes effect on restart even while the settings cache is warm.
 */
export function withPolicyManagedPaths(configFilePaths: string[]): string[] {
  const policy = config.policyManagedSettings
  if (policy.length === 0) return configFilePaths
  return [...new Set([...configFilePaths, ...policy])]
}

/** Internal entry point exposed for direct testing without the
 *  getTenantSettings() round-trip. Production callers use
 *  `assertNotManaged`. */
export async function _internalAssertNotManaged(
  path: string,
  readPaths: () => Promise<string[]>
): Promise<void> {
  const managed = await readPaths()
  if (isPathManaged(path, managed)) {
    throw new ForbiddenError(
      'FIELD_MANAGED',
      `Field "${path}" is managed by your administrator's config; cannot be edited in-app.`
    )
  }
}
