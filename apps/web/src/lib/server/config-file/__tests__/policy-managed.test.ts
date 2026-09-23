import { afterEach, describe, it, expect, vi } from 'vitest'
import { parsePolicyManagedSettings, POLICY_MANAGED_PATH_OPTIONS } from '@/lib/server/config'
import { withPolicyManagedPaths } from '../managed-guard'
import { isPathManaged } from '../managed-paths'

describe('parsePolicyManagedSettings', () => {
  it('returns nothing when the variable is unset or empty', () => {
    expect(parsePolicyManagedSettings(undefined)).toEqual([])
    expect(parsePolicyManagedSettings('')).toEqual([])
  })

  it('keeps known paths, trims, de-duplicates and ignores unknown entries', () => {
    expect(
      parsePolicyManagedSettings(
        ' portal.access.visibility , auth.oauth,boards.access,auth.oauth, workspace.name,,'
      )
    ).toEqual(['portal.access.visibility', 'auth.oauth', 'boards.access'])
  })

  it('accepts every documented option', () => {
    expect(parsePolicyManagedSettings(POLICY_MANAGED_PATH_OPTIONS.join(','))).toEqual([
      ...POLICY_MANAGED_PATH_OPTIONS,
    ])
  })
})

describe('withPolicyManagedPaths', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the config-file list unchanged when no policy paths are set', () => {
    vi.stubEnv('POLICY_MANAGED_SETTINGS', '')
    expect(withPolicyManagedPaths(['workspace.name'])).toEqual(['workspace.name'])
  })

  it('adds the policy paths so per-provider oauth paths are locked by the auth.oauth block', () => {
    vi.stubEnv('POLICY_MANAGED_SETTINGS', 'auth.oauth,portal.features.allowAnonymous')
    const managed = withPolicyManagedPaths(['workspace.name'])
    expect(managed).toEqual(['workspace.name', 'auth.oauth', 'portal.features.allowAnonymous'])
    expect(isPathManaged('auth.oauth.github', managed)).toBe(true)
    expect(isPathManaged('portal.features.allowAnonymous', managed)).toBe(true)
    expect(isPathManaged('portal.access.visibility', managed)).toBe(false)
  })
})
