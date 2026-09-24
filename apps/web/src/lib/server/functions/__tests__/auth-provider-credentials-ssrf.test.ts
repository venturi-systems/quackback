import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  mockSavePlatformCredentials: vi.fn(async () => undefined),
  mockGetTierLimits: vi.fn(),
  mockCheckUrlSafety: vi.fn(),
}))

vi.mock('../auth-helpers', () => ({
  requireAuth: vi.fn(async () => ({ principal: { id: 'principal_admin' } })),
}))
vi.mock('@/lib/server/domains/platform-credentials/platform-credential.service', () => ({
  savePlatformCredentials: hoisted.mockSavePlatformCredentials,
  deletePlatformCredentials: vi.fn(),
  getPlatformCredentials: vi.fn(),
  getConfiguredIntegrationTypes: vi.fn(async () => new Set()),
}))
vi.mock('@/lib/server/auth/index', () => ({ resetAuth: vi.fn() }))
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: hoisted.mockGetTierLimits,
}))
vi.mock('@/lib/server/content/ssrf-guard', () => ({
  checkUrlSafety: (...args: unknown[]) => hoisted.mockCheckUrlSafety(...args),
}))

import { OSS_TIER_LIMITS } from '@/lib/server/domains/settings/tier-limits.types'
import { saveAuthProviderCredentialsFn } from '../auth-provider-credentials'

const oidcCreds = {
  clientId: 'client_abc',
  clientSecret: 'secret_xyz',
  discoveryUrl: 'https://idp.internal.acme.com/.well-known/openid-configuration',
}

describe('saveAuthProviderCredentialsFn — SSRF URL guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // customOidcProvider on, so the tier gate passes and we reach the URL check.
    hoisted.mockGetTierLimits.mockResolvedValue(OSS_TIER_LIMITS)
  })

  it('rejects a custom-OIDC URL that fails the SSRF guard, before storing', async () => {
    hoisted.mockCheckUrlSafety.mockResolvedValue({ safe: false, reason: 'ssrf-rejected' })

    await expect(
      saveAuthProviderCredentialsFn({
        data: { credentialType: 'auth_custom-oidc', credentials: oidcCreds },
      })
    ).rejects.toThrow(/valid public URL/i)

    expect(hoisted.mockCheckUrlSafety).toHaveBeenCalledWith(oidcCreds.discoveryUrl)
    expect(hoisted.mockSavePlatformCredentials).not.toHaveBeenCalled()
  })

  it('stores the credentials when the URL passes the guard', async () => {
    hoisted.mockCheckUrlSafety.mockResolvedValue({ safe: true, address: '203.0.113.7', family: 4 })

    await saveAuthProviderCredentialsFn({
      data: { credentialType: 'auth_custom-oidc', credentials: oidcCreds },
    })

    expect(hoisted.mockCheckUrlSafety).toHaveBeenCalledWith(oidcCreds.discoveryUrl)
    expect(hoisted.mockSavePlatformCredentials).toHaveBeenCalledTimes(1)
  })

  // Better-Auth's GitLab provider sends the code, client secret and access
  // token to `${issuer}/oauth/token` and `${issuer}/api/v4/user`.
  it('rejects a self-hosted GitLab issuer that fails the SSRF guard, before storing', async () => {
    hoisted.mockCheckUrlSafety.mockResolvedValue({ safe: false, reason: 'ssrf-rejected' })
    const issuer = 'http://169.254.169.254'

    await expect(
      saveAuthProviderCredentialsFn({
        data: {
          credentialType: 'auth_gitlab',
          credentials: { clientId: 'gl', clientSecret: 'gl', issuer },
        },
      })
    ).rejects.toThrow(/valid public URL/i)

    expect(hoisted.mockCheckUrlSafety).toHaveBeenCalledWith(issuer)
    expect(hoisted.mockSavePlatformCredentials).not.toHaveBeenCalled()
  })

  // Sign-in refuses a plain-http issuer or endpoint, so saving one would only
  // produce a sign-in that fails later. The public-address check alone
  // accepts http, so this is a separate rule.
  it('rejects a plain-http self-hosted GitLab issuer, before storing', async () => {
    hoisted.mockCheckUrlSafety.mockResolvedValue({ safe: true, address: '203.0.113.7', family: 4 })

    await expect(
      saveAuthProviderCredentialsFn({
        data: {
          credentialType: 'auth_gitlab',
          credentials: { clientId: 'gl', clientSecret: 'gl', issuer: 'http://gitlab.acme.example' },
        },
      })
    ).rejects.toThrow(/https:\/\/ URL/)

    expect(hoisted.mockSavePlatformCredentials).not.toHaveBeenCalled()
  })

  it('rejects a plain-http custom-OIDC discovery URL, before storing', async () => {
    hoisted.mockCheckUrlSafety.mockResolvedValue({ safe: true, address: '203.0.113.7', family: 4 })
    const credentials = {
      ...oidcCreds,
      discoveryUrl: 'http://idp.acme.example/.well-known/openid-configuration',
    }

    await expect(
      saveAuthProviderCredentialsFn({ data: { credentialType: 'auth_custom-oidc', credentials } })
    ).rejects.toThrow(/https:\/\/ URL/)

    expect(hoisted.mockSavePlatformCredentials).not.toHaveBeenCalled()
  })

  it('skips the guard for GitLab when no self-hosted issuer is set', async () => {
    await saveAuthProviderCredentialsFn({
      data: { credentialType: 'auth_gitlab', credentials: { clientId: 'gl', clientSecret: 'gl' } },
    })

    expect(hoisted.mockCheckUrlSafety).not.toHaveBeenCalled()
    expect(hoisted.mockSavePlatformCredentials).toHaveBeenCalledTimes(1)
  })

  it('skips the guard for providers with no URL fields (built-in Google)', async () => {
    await saveAuthProviderCredentialsFn({
      data: { credentialType: 'auth_google', credentials: { clientId: 'g', clientSecret: 'g' } },
    })

    expect(hoisted.mockCheckUrlSafety).not.toHaveBeenCalled()
    expect(hoisted.mockSavePlatformCredentials).toHaveBeenCalledTimes(1)
  })
})
