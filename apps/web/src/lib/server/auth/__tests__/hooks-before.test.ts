/**
 * Layer B pre-session gate (`handleSignInPreCheck`) — comprehensive
 * scenario matrix.
 *
 * This is the request-time policy oracle for password / magic-link /
 * email-OTP sign-in attempts. It runs BEFORE Better-Auth verifies the
 * credential, so a block here means the redirect lands without any
 * password check ever happening. OAuth callback paths are gated by
 * Layer A (registration filter) and Layer C (post-session cleanup)
 * instead — those paths land in `NO_EMAIL_BEFORE_PATHS` and exit
 * early here.
 *
 * Matrix dimensions exercised:
 *   - provider: credential / magic-link / sso / non-listed
 *   - path: gated / NO_EMAIL_BEFORE_PATH / unrecognised
 *   - email: present / missing
 *   - per-domain: verified-enforced / verified-routing-only / none
 *   - principal: admin / member / user / missing (brand-new sign-up; the
 *     method gate applies to it too)
 *   - oauth toggles: password on/off / magic-link on/off
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAuthConfig, makeTenant, makeVerifiedDomain } from './_helpers'

const mockUserFindFirst = vi.fn()
const mockPrincipalFindFirst = vi.fn()
const mockGetTenantSettings = vi.fn()
const mockGetPublicPortalConfig = vi.fn()

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      user: { findFirst: (...a: unknown[]) => mockUserFindFirst(...a) },
      principal: { findFirst: (...a: unknown[]) => mockPrincipalFindFirst(...a) },
    },
  },
  user: { id: 'user_id', email: 'user_email' },
  principal: { userId: 'principal_userId', role: 'role' },
  eq: vi.fn(),
}))

vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getTenantSettings: (...a: unknown[]) => mockGetTenantSettings(...a),
  getPublicPortalConfig: (...a: unknown[]) => mockGetPublicPortalConfig(...a),
}))

const mockCheckSignInRateLimit = vi.fn()
const mockCheckMagicLinkRateLimit = vi.fn()
vi.mock('@/lib/server/auth/signin-rate-limit', () => ({
  checkCredentialSignInRateLimit: (ip: string, email: string) =>
    mockCheckSignInRateLimit(ip, email),
  checkMagicLinkSendRateLimit: (ip: string, email: string) =>
    mockCheckMagicLinkRateLimit(ip, email),
}))

const mockRecordAuditEvent = vi.fn(async (_spec: unknown) => undefined)
vi.mock('@/lib/server/audit/log', () => ({
  recordAuditEvent: (spec: unknown) => mockRecordAuditEvent(spec),
}))

vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers(),
}))

// Task 12: handleSignInPreCheck now resolves the owning provider + the
// registered-OIDC set from the provider registry (instead of
// isSsoActuallyRegistered). Mock both. The single-provider regression
// baseline maps every verified domain onto one owning provider 'sso';
// `getRegisteredOidcProviderIds` returns {'sso'} when SSO is "registered".
// Tests for tier-downgrade / missing-secret override the set to empty.
const mockListIdentityProviders = vi.fn()
vi.mock('@/lib/server/domains/settings/identity-providers.service', () => ({
  listIdentityProviders: (...a: unknown[]) => mockListIdentityProviders(...a),
}))

const mockGetRegisteredOidcProviderIds = vi.fn()
vi.mock('@/lib/server/auth/registered-providers', () => ({
  getRegisteredOidcProviderIds: (...a: unknown[]) => mockGetRegisteredOidcProviderIds(...a),
}))

// auth-restrictions stays unmocked — we want the real predicates to
// run so we test the integration, not just the wiring.

const { handleSignInPreCheck } = await import('../hooks')

type Ctx = Parameters<typeof handleSignInPreCheck>[0]
type Knobs = {
  ssoEnabled?: boolean
  passwordEnabled?: boolean
  magicLinkEnabled?: boolean
  verifiedDomains?: ReturnType<typeof makeVerifiedDomain>[]
}

const tenant = (k: Knobs = {}) => {
  const verifiedDomains = k.verifiedDomains ?? []
  const t = makeTenant({
    authConfig: makeAuthConfig({
      oauth: { password: k.passwordEnabled, magicLink: k.magicLinkEnabled },
      ssoOidc: {
        // `enabled` defaults to true so existing tests exercising
        // per-domain enforcement keep their semantics.
        // Tests that need a disabled-SSO workspace pass `ssoEnabled: false`.
        enabled: k.ssoEnabled ?? true,
      },
    }),
    verifiedDomains,
  })
  // Side-effect: mirror this tenant's verified domains onto the single
  // owning provider 'sso' and derive its registered-set membership from
  // ssoEnabled (matching the prior isSsoActuallyRegistered default). Tests
  // exercising the fail-open path override mockGetRegisteredOidcProviderIds.
  mockListIdentityProviders.mockResolvedValue([
    { id: 'idp_sso', registrationId: 'sso', domains: verifiedDomains },
  ])
  mockGetRegisteredOidcProviderIds.mockResolvedValue(
    (k.ssoEnabled ?? true) ? new Set(['sso']) : new Set<string>()
  )
  return t
}

const ctxFor = (path: string, body?: Record<string, unknown>): Ctx => ({
  path,
  body,
  redirect: vi.fn((url: string) => new Error(`REDIRECT:${url}`)),
})

beforeEach(() => {
  vi.clearAllMocks()
  mockUserFindFirst.mockResolvedValue(null)
  mockPrincipalFindFirst.mockResolvedValue(null)
  mockGetTenantSettings.mockResolvedValue(tenant())
  mockGetPublicPortalConfig.mockResolvedValue({
    oauth: { password: true, magicLink: false },
  })
  // The provider-registry mocks are seeded by the `tenant()` call above.
  mockCheckSignInRateLimit.mockResolvedValue({ allowed: true })
  mockCheckMagicLinkRateLimit.mockResolvedValue({ allowed: true })
})

// ============================================================
// Early-exit guards
// ============================================================

describe('handleSignInPreCheck — early exits', () => {
  it('skips when path is unrecognised (no provider inferred)', async () => {
    const ctx = ctxFor('/some/unknown/path', { email: 'a@b.com' })
    await handleSignInPreCheck(ctx)
    expect(mockGetTenantSettings).not.toHaveBeenCalled()
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('skips when path is in NO_EMAIL_BEFORE_PATHS (e.g. /sign-in/social)', async () => {
    const ctx = ctxFor('/sign-in/social', { email: 'a@b.com', provider: 'google' })
    await handleSignInPreCheck(ctx)
    expect(mockGetTenantSettings).not.toHaveBeenCalled()
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('skips when path is /oauth2/callback/:providerId (Layer C handles those)', async () => {
    const ctx = ctxFor('/oauth2/callback/:providerId', { email: 'a@b.com' })
    ctx.params = { providerId: 'sso' }
    await handleSignInPreCheck(ctx)
    expect(mockGetTenantSettings).not.toHaveBeenCalled()
  })

  it('skips when ctx.body.email is missing (magic-link verify path)', async () => {
    const ctx = ctxFor('/magic-link/verify', { token: 'xyz' })
    await handleSignInPreCheck(ctx)
    expect(mockGetTenantSettings).not.toHaveBeenCalled()
  })

  it('lower-cases and trims email before checking', async () => {
    const ctx = ctxFor('/sign-in/email', { email: '  Foo@Acme.COM  ' })
    mockGetTenantSettings.mockResolvedValue(
      tenant({ verifiedDomains: [makeVerifiedDomain('acme.com', true)] })
    )
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(/verified_domain_requires_sso/)
  })
})

// ============================================================
// Per-domain hard-binding (enforced verified domain)
// ============================================================

describe('handleSignInPreCheck — per-domain enforced', () => {
  beforeEach(() => {
    mockGetTenantSettings.mockResolvedValue(
      tenant({
        verifiedDomains: [makeVerifiedDomain('acme.com', true)],
      })
    )
  })

  it('blocks password sign-in for admin at enforced verified domain', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@acme.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(
      'REDIRECT:/?auth=signin&callbackUrl=/admin&error=verified_domain_requires_sso'
    )
  })

  it('blocks password sign-in for member at enforced verified domain', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'member' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@acme.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(/verified_domain_requires_sso/)
  })

  it('blocks password sign-in for portal user at enforced verified domain (domain branch is role-blind)', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'user' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@acme.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(/verified_domain_requires_sso/)
  })

  it('blocks brand-new sign-ups (no principal yet) at enforced verified domain', async () => {
    mockUserFindFirst.mockResolvedValue(null)
    mockPrincipalFindFirst.mockResolvedValue(null)
    const ctx = ctxFor('/sign-up/email', { email: 'newhire@acme.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(/verified_domain_requires_sso/)
  })

  it('blocks magic-link send for enforced-domain email', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/magic-link', { email: 'a@acme.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(/verified_domain_requires_sso/)
  })

  it('does NOT block when the verified-domain row has enforced=false (routing-only)', async () => {
    mockGetTenantSettings.mockResolvedValue(
      tenant({
        verifiedDomains: [makeVerifiedDomain('acme.com', false)],
      })
    )
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@acme.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('does not match a different domain (no enforce on example.com when acme.com is enforced)', async () => {
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@example.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })
})

// ============================================================
// Method-allowed fall-through (toggles)
// ============================================================

describe('handleSignInPreCheck — isAuthMethodAllowed gate', () => {
  it('blocks credential when oauth.password is explicitly false for team', async () => {
    mockGetTenantSettings.mockResolvedValue(tenant({ passwordEnabled: false }))
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@anywhere.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(/password_method_not_allowed/)
  })

  it('allows credential when oauth.password is undefined (defaults to true for team)', async () => {
    mockGetTenantSettings.mockResolvedValue(tenant({})) // no passwordEnabled
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@anywhere.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('redirects team-role blocks to the unified login with a /admin callback', async () => {
    mockGetTenantSettings.mockResolvedValue(tenant({ passwordEnabled: false }))
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@anywhere.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(
      /\/\?auth=signin&callbackUrl=\/admin&error=password_method_not_allowed/
    )
  })

  it('returns silently when no principal exists (sign-up path) and provider is allowed', async () => {
    mockGetTenantSettings.mockResolvedValue(tenant({}))
    mockUserFindFirst.mockResolvedValue(null)
    mockPrincipalFindFirst.mockResolvedValue(null)
    const ctx = ctxFor('/sign-up/email', { email: 'brand@new.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  // A brand-new identity (no user or principal row) used to skip this gate,
  // so a disabled method still accepted sign-ups: production on 2026-09-24,
  // with password sign-in off, answered POST /sign-up/email for an unused
  // address with Better Auth's PASSWORD_TOO_SHORT, i.e. past every gate.
  it('refuses /sign-up/email for a brand-new identity when oauth.password=false', async () => {
    mockGetTenantSettings.mockResolvedValue(tenant({ passwordEnabled: false }))
    mockUserFindFirst.mockResolvedValue(null)
    mockPrincipalFindFirst.mockResolvedValue(null)
    const ctx = ctxFor('/sign-up/email', { email: 'squatter@anywhere.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(
      'REDIRECT:/?auth=signin&error=password_method_not_allowed'
    )
  })

  it('refuses /sign-in/email for an unknown address the same way as a known one', async () => {
    mockGetTenantSettings.mockResolvedValue(tenant({ passwordEnabled: false }))
    const ctx = ctxFor('/sign-in/email', { email: 'nobody@anywhere.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(/password_method_not_allowed/)
  })

  it.each(['/sign-in/magic-link', '/email-otp/send-verification-otp', '/sign-in/email-otp'])(
    'refuses %s for a brand-new identity while magic link is off',
    async (path) => {
      mockGetTenantSettings.mockResolvedValue(tenant({ magicLinkEnabled: false }))
      mockUserFindFirst.mockResolvedValue(null)
      mockPrincipalFindFirst.mockResolvedValue(null)
      const ctx = ctxFor(path, { email: 'newcomer@anywhere.com' })

      await expect(handleSignInPreCheck(ctx)).rejects.toThrow(
        'REDIRECT:/?auth=signin&error=magic_link_method_not_allowed'
      )
    }
  )

  it('lets a brand-new identity through while magic link is on', async () => {
    mockGetTenantSettings.mockResolvedValue(tenant({ magicLinkEnabled: true }))
    mockUserFindFirst.mockResolvedValue(null)
    mockPrincipalFindFirst.mockResolvedValue(null)
    const ctx = ctxFor('/email-otp/send-verification-otp', { email: 'newcomer@anywhere.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  // Team identity rule (landing-page#2309): a password sign-up at a team
  // domain is refused even while password sign-in is on. Its unverified row
  // would block the owner's first Google or GitHub sign-in, and after the
  // owner verified the address by magic link and linked Google or GitHub,
  // the creator's password would open an account holding a team role.
  describe('password sign-up at a team domain', () => {
    beforeEach(() => {
      vi.stubEnv('VENTURI_TEAM_EMAIL_DOMAINS', 'venturi.systems')
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it.each(['newhire@venturi.systems', ' NewHire@Venturi.Systems '])(
      'refuses /sign-up/email for %s while password sign-in is on',
      async (email) => {
        mockGetTenantSettings.mockResolvedValue(tenant({ passwordEnabled: true }))
        const ctx = ctxFor('/sign-up/email', { email })

        await expect(handleSignInPreCheck(ctx)).rejects.toThrow(
          'REDIRECT:/?auth=signin&error=team_identity_required'
        )
      }
    )

    it('keeps password sign-up open outside the team domains', async () => {
      mockGetTenantSettings.mockResolvedValue(tenant({ passwordEnabled: true }))
      const ctx = ctxFor('/sign-up/email', { email: 'someone@venturi.systems.example' })

      await handleSignInPreCheck(ctx)
      expect(ctx.redirect).not.toHaveBeenCalled()
    })

    it('does not refuse a magic-link send to a team-domain address (it proves the inbox)', async () => {
      mockGetTenantSettings.mockResolvedValue(tenant({ magicLinkEnabled: true }))
      const ctx = ctxFor('/sign-in/magic-link', { email: 'newhire@venturi.systems' })

      await handleSignInPreCheck(ctx)
      expect(ctx.redirect).not.toHaveBeenCalled()
    })
  })

  it('magic-link is allowed for team when oauth.magicLink toggle is true (verified-domain check separately gates)', async () => {
    // Per the `isAuthMethodAllowed` code: magic-link for team is now
    // gated by `authConfig.oauth.magicLink`. When the toggle is on,
    // only hard-binding can block magic-link.
    mockGetTenantSettings.mockResolvedValue(tenant({ magicLinkEnabled: true }))
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/magic-link', { email: 'a@anywhere.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })
})

// ============================================================
// Master switch: ssoOidc.enabled=false makes all enforcement dormant
// ============================================================

describe('handleSignInPreCheck — ssoOidc.enabled=false (workspace SSO disabled)', () => {
  it('does NOT block admin password sign-in even with stale enforced verified-domain row', async () => {
    mockGetTenantSettings.mockResolvedValue(
      tenant({
        ssoEnabled: false,
        verifiedDomains: [makeVerifiedDomain('acme.com', true)],
      })
    )
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@acme.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('does NOT block admin magic-link with stale enforced verified-domain row', async () => {
    mockGetTenantSettings.mockResolvedValue(
      tenant({
        ssoEnabled: false,
        magicLinkEnabled: true,
        verifiedDomains: [makeVerifiedDomain('acme.com', true)],
      })
    )
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/magic-link', { email: 'a@acme.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('still gates by method-allowed (password disabled → still blocks)', async () => {
    // The master SSO switch only affects SSO enforcement. Other policy
    // (oauth.password=false) keeps working independently.
    mockGetTenantSettings.mockResolvedValue(tenant({ ssoEnabled: false, passwordEnabled: false }))
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@anywhere.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(/password_method_not_allowed/)
  })
})

// ============================================================
// Runtime fail-open — SSO is admin-configured but not viable
// ============================================================

describe('handleSignInPreCheck — tier-downgrade / missing-secret fail-open', () => {
  // Admin has SSO enabled and an enforced verified-domain row, but the
  // runtime can't actually use it: tier was downgraded or the secret got
  // rotated and cleared. Layer A has already unregistered the SSO provider,
  // so there's no SSO button. Without fail-open, password sign-in would
  // also be blocked → total lockout. The runtime check undoes the
  // enforcement until the operator fixes things.
  it('allows admin password sign-in at enforced verified domain when SSO not registered (tier downgrade)', async () => {
    mockGetTenantSettings.mockResolvedValue(
      tenant({ ssoEnabled: true, verifiedDomains: [makeVerifiedDomain('acme.com', true)] })
    )
    mockGetRegisteredOidcProviderIds.mockResolvedValue(new Set<string>())
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@acme.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('allows admin magic-link too when SSO not registered', async () => {
    mockGetTenantSettings.mockResolvedValue(
      tenant({
        ssoEnabled: true,
        magicLinkEnabled: true,
        verifiedDomains: [makeVerifiedDomain('acme.com', true)],
      })
    )
    mockGetRegisteredOidcProviderIds.mockResolvedValue(new Set<string>())
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/magic-link', { email: 'a@acme.com' })

    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('still blocks when ssoRegistered=true and enforcement says so (regression)', async () => {
    // Sanity: the fail-open must not invert. Same input as the
    // "blocks password sign-in for admin at enforced verified domain"
    // test in the per-domain suite — should still block.
    mockGetTenantSettings.mockResolvedValue(
      tenant({
        ssoEnabled: true,
        verifiedDomains: [makeVerifiedDomain('acme.com', true)],
      })
    )
    mockGetRegisteredOidcProviderIds.mockResolvedValue(new Set(['sso']))
    mockUserFindFirst.mockResolvedValue({ id: 'user_1' })
    mockPrincipalFindFirst.mockResolvedValue({ role: 'admin' })
    const ctx = ctxFor('/sign-in/email', { email: 'a@acme.com' })

    await expect(handleSignInPreCheck(ctx)).rejects.toThrow(/verified_domain_requires_sso/)
  })
})

describe('handleSignInPreCheck — sign-in rate-limit', () => {
  it('throws a 429 APIError with code=rate_limited when the limiter blocks', async () => {
    mockCheckSignInRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 120 })
    const ctx = ctxFor('/sign-in/email', { email: 'a@b.com' })
    // The pre-check must NOT 302-redirect — sign-in submits are XHR, and
    // redirect-then-detect is more fragile than a direct JSON error. The
    // auth client surfaces `body.message` as `result.error.message`.
    const err = await handleSignInPreCheck(ctx).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { name?: string }).name).toBe('APIError')
    expect((err as { status?: string }).status).toBe('TOO_MANY_REQUESTS')
    expect((err as { statusCode?: number }).statusCode).toBe(429)
    expect((err as { body?: { code?: string; message?: string } }).body?.code).toBe('rate_limited')
    expect((err as { body?: { message?: string } }).body?.message).toMatch(
      /too many sign-in attempts/i
    )
    // Retry-After must be propagated so future clients can show a countdown.
    expect((err as { headers?: Record<string, string> }).headers?.['Retry-After']).toBe('120')
    // Must not have called the redirect helper.
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('emits auth.signin.rate_limited audit row on block', async () => {
    mockCheckSignInRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 120 })
    const ctx = ctxFor('/sign-in/email', { email: 'a@b.com' })
    await expect(handleSignInPreCheck(ctx)).rejects.toBeDefined()

    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth.signin.rate_limited' })
    )
  })

  it('short-circuits all downstream work when rate-limited (cheapest reject)', async () => {
    // Rate-limit fires BEFORE the tenant fetch so a DB hiccup can't
    // mask a 429 with a 500. No tenant settings, user, or principal
    // lookups should fire when the limiter blocks.
    mockCheckSignInRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 60 })
    const ctx = ctxFor('/sign-in/email', { email: 'a@b.com' })
    await expect(handleSignInPreCheck(ctx)).rejects.toBeDefined()

    expect(mockGetTenantSettings).not.toHaveBeenCalled()
    expect(mockUserFindFirst).not.toHaveBeenCalled()
    expect(mockPrincipalFindFirst).not.toHaveBeenCalled()
  })

  it('omits Retry-After header when the limiter did not provide one', async () => {
    // Defensive: bucketRetryAfter can return undefined in some Redis edge
    // cases. The header should be omitted entirely (not set to "undefined").
    mockCheckSignInRateLimit.mockResolvedValueOnce({ allowed: false })
    const ctx = ctxFor('/sign-in/email', { email: 'a@b.com' })
    const err = await handleSignInPreCheck(ctx).catch((e) => e)
    expect((err as { headers?: Record<string, string> }).headers?.['Retry-After']).toBeUndefined()
  })

  it('passes when the limiter allows (allowed=true → no redirect)', async () => {
    mockCheckSignInRateLimit.mockResolvedValueOnce({ allowed: true })
    const ctx = ctxFor('/sign-in/email', { email: 'a@b.com' })
    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('does NOT rate-limit OAuth callback paths (no credential flow there)', async () => {
    const ctx = ctxFor('/sign-in/social', { email: 'a@b.com', provider: 'google' })
    await handleSignInPreCheck(ctx)
    expect(mockCheckSignInRateLimit).not.toHaveBeenCalled()
    expect(mockCheckMagicLinkRateLimit).not.toHaveBeenCalled()
  })

  it('does not invert when limiter call throws (fail-open)', async () => {
    mockCheckSignInRateLimit.mockRejectedValueOnce(new Error('boom'))
    const ctx = ctxFor('/sign-in/email', { email: 'a@b.com' })
    // The helper itself fails open via try/catch, but this test
    // asserts the hook's resilience even if the helper promise rejects.
    await handleSignInPreCheck(ctx)
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('dispatches the magic-link limiter on /sign-in/magic-link (not the credential limiter)', async () => {
    // Magic link is opt-in; switch it on so the brand-new address passes the
    // method gate and this case stays about limiter dispatch.
    mockGetTenantSettings.mockResolvedValue(tenant({ magicLinkEnabled: true }))
    const ctx = ctxFor('/sign-in/magic-link', { email: 'a@b.com' })
    await handleSignInPreCheck(ctx)
    expect(mockCheckMagicLinkRateLimit).toHaveBeenCalledWith(expect.any(String), 'a@b.com')
    expect(mockCheckSignInRateLimit).not.toHaveBeenCalled()
  })

  it('blocks magic-link send when the magic-link limiter caps', async () => {
    mockCheckMagicLinkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 600 })
    const ctx = ctxFor('/sign-in/magic-link', { email: 'a@b.com' })
    const err = await handleSignInPreCheck(ctx).catch((e) => e)
    expect((err as { body?: { code?: string } }).body?.code).toBe('rate_limited')
    expect((err as { statusCode?: number }).statusCode).toBe(429)
  })

  it('dispatches the credential limiter on /sign-in/email (not the magic-link limiter)', async () => {
    const ctx = ctxFor('/sign-in/email', { email: 'a@b.com' })
    await handleSignInPreCheck(ctx)
    expect(mockCheckSignInRateLimit).toHaveBeenCalledWith(expect.any(String), 'a@b.com')
    expect(mockCheckMagicLinkRateLimit).not.toHaveBeenCalled()
  })
})
