import { afterEach, describe, it, expect, vi } from 'vitest'

// The parser reports ignored entries through the structured logger; mock it so
// the child logger's `.warn` is a spy.
const { logSpies } = vi.hoisted(() => ({
  logSpies: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}))
vi.mock('@/lib/server/logger', () => {
  const child = () => ({ ...logSpies, child })
  return { logger: { ...logSpies, child }, createLogger: () => ({ ...logSpies, child }) }
})
import { parsePolicyManagedSettings, POLICY_MANAGED_PATH_OPTIONS } from '@/lib/server/config'
import { withPolicyManagedPaths } from '../managed-guard'
import { isPathManaged } from '../managed-paths'
import { authOauthManagedPath, boardAccessManagedPath } from '@/lib/shared/policy-managed-paths'

describe('parsePolicyManagedSettings', () => {
  it('returns nothing when the variable is unset or empty', () => {
    expect(parsePolicyManagedSettings(undefined)).toEqual([])
    expect(parsePolicyManagedSettings('')).toEqual([])
  })

  it('keeps known paths, trims, de-duplicates and ignores unknown entries', () => {
    expect(
      parsePolicyManagedSettings(
        ' portal.access.visibility , auth.oauth,auth.openSignup,auth.oauth, workspace.name,,'
      )
    ).toEqual(['portal.access.visibility', 'auth.oauth', 'auth.openSignup'])
  })

  it('accepts every documented option', () => {
    expect(parsePolicyManagedSettings(POLICY_MANAGED_PATH_OPTIONS.join(','))).toEqual([
      ...POLICY_MANAGED_PATH_OPTIONS,
    ])
  })

  it('accepts one board by slug and one sign-in method by id', () => {
    expect(
      parsePolicyManagedSettings(
        'boards.feature-requests.access,boards.security-review.access,auth.oauth.github,auth.oauth.custom-oidc'
      )
    ).toEqual([
      'boards.feature-requests.access',
      'boards.security-review.access',
      'auth.oauth.github',
      'auth.oauth.custom-oidc',
    ])
  })

  it('warns once per distinct value, not on every read of the getter', () => {
    logSpies.warn.mockClear()
    const raw = 'auth.oauth,boards.access,portal.welcomeCard'
    for (let i = 0; i < 3; i++) expect(parsePolicyManagedSettings(raw)).toEqual(['auth.oauth'])
    expect(logSpies.warn).toHaveBeenCalledTimes(1)
    expect(logSpies.warn).toHaveBeenCalledWith(
      { paths: ['boards.access', 'portal.welcomeCard'] },
      'ignoring unknown POLICY_MANAGED_SETTINGS entries'
    )
    parsePolicyManagedSettings('auth.oauth,portal.welcomeCard')
    expect(logSpies.warn).toHaveBeenCalledTimes(2)
    parsePolicyManagedSettings('auth.oauth,auth.openSignup')
    expect(logSpies.warn).toHaveBeenCalledTimes(2)
  })

  it('rejects whole-collection and malformed paths, which would lock more than one field owns', () => {
    for (const path of [
      'boards.access',
      'boards',
      'boards.Feature.access',
      'boards.feature-requests',
      'boards.feature-requests.access.view',
      'boards..access',
      'portal.access',
      'portal.features',
      'auth',
      'auth.oauth.',
      'auth.twoFactor.required',
    ]) {
      expect(parsePolicyManagedSettings(path), path).toEqual([])
    }
  })
})

describe('policy-managed field-level coverage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('locks the listed boards only, never their siblings', () => {
    vi.stubEnv('POLICY_MANAGED_SETTINGS', 'boards.feature-requests.access')
    const managed = withPolicyManagedPaths([])
    expect(isPathManaged(boardAccessManagedPath('feature-requests'), managed)).toBe(true)
    expect(isPathManaged(boardAccessManagedPath('bug-reports'), managed)).toBe(false)
    expect(isPathManaged(boardAccessManagedPath('feature-requests-archive'), managed)).toBe(false)
  })

  it('locks one sign-in method without its siblings, and open sign-up on its own path', () => {
    vi.stubEnv('POLICY_MANAGED_SETTINGS', 'auth.oauth.github,auth.openSignup')
    const managed = withPolicyManagedPaths([])
    expect(isPathManaged(authOauthManagedPath('github'), managed)).toBe(true)
    expect(isPathManaged(authOauthManagedPath('google'), managed)).toBe(false)
    expect(isPathManaged('auth.openSignup', managed)).toBe(true)
    expect(isPathManaged('auth.twoFactor.required', managed)).toBe(false)
  })

  it('does not treat a managed field as covering a sibling that shares its prefix', () => {
    vi.stubEnv('POLICY_MANAGED_SETTINGS', 'portal.access.visibility,portal.features.allowAnonymous')
    const managed = withPolicyManagedPaths([])
    expect(isPathManaged('portal.access.allowedDomains', managed)).toBe(false)
    expect(isPathManaged('portal.features.allowAnonymousVoting', managed)).toBe(false)
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
