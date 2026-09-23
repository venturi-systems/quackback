/**
 * hooks.before gates added for the feedback portal authorization work:
 *
 *   - handleAnonymousSignInGate: `POST /sign-in/anonymous` is refused unless
 *     the workspace explicitly allows anonymous interaction (read fail-closed
 *     from the RAW settings row, like every anonymous write gate).
 *   - handleClientRegistrationGate: `POST /oauth2/register` refuses an
 *     anonymous Better Auth session; callers with no session fall through to
 *     the OAuth provider's own `allowUnauthenticatedClientRegistration` check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { APIError } from 'better-auth/api'

const mockGetTenantSettings = vi.fn()
const mockPrincipalFindFirst = vi.fn()

vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getTenantSettings: (...a: unknown[]) => mockGetTenantSettings(...a),
}))

vi.mock('@/lib/server/db', () => ({
  db: { query: { principal: { findFirst: (...a: unknown[]) => mockPrincipalFindFirst(...a) } } },
  principal: { userId: 'principal_userId', type: 'type' },
  eq: vi.fn(),
}))

vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers(),
}))

const {
  handleAnonymousSignInGate,
  handleClientRegistrationGate,
  ANONYMOUS_SIGN_IN_DISABLED_MESSAGE,
} = await import('../hooks')

const tenantWithPortalConfig = (portalConfig: unknown) => ({
  settings: { portalConfig: portalConfig === undefined ? undefined : JSON.stringify(portalConfig) },
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleAnonymousSignInGate', () => {
  it('ignores every path other than /sign-in/anonymous', async () => {
    await expect(handleAnonymousSignInGate({ path: '/sign-in/email' })).resolves.toBeUndefined()
    await expect(handleAnonymousSignInGate({ path: undefined })).resolves.toBeUndefined()
    expect(mockGetTenantSettings).not.toHaveBeenCalled()
  })

  it('allows anonymous sign-in when features.allowAnonymous is explicitly true', async () => {
    mockGetTenantSettings.mockResolvedValue(
      tenantWithPortalConfig({ features: { allowAnonymous: true } })
    )
    await expect(handleAnonymousSignInGate({ path: '/sign-in/anonymous' })).resolves.toBeUndefined()
  })

  it.each([
    [
      'allowAnonymous false (the live gated posture)',
      tenantWithPortalConfig({ features: { allowAnonymous: false } }),
    ],
    ['allowAnonymous missing', tenantWithPortalConfig({ features: {} })],
    ['portal_config NULL', { settings: { portalConfig: null } }],
    ['no settings row (fresh install)', null],
  ])('refuses anonymous sign-in with %s', async (_label, tenant) => {
    mockGetTenantSettings.mockResolvedValue(tenant)
    const err = await handleAnonymousSignInGate({ path: '/sign-in/anonymous' }).catch((e) => e)
    expect(err).toBeInstanceOf(APIError)
    expect((err as APIError).status).toBe('FORBIDDEN')
    expect((err as APIError).body).toMatchObject({
      code: 'anonymous_sign_in_disabled',
      message: ANONYMOUS_SIGN_IN_DISABLED_MESSAGE,
    })
  })

  it('refuses (fails closed) when the settings read throws', async () => {
    mockGetTenantSettings.mockRejectedValue(new Error('db down'))
    await expect(handleAnonymousSignInGate({ path: '/sign-in/anonymous' })).rejects.toBeInstanceOf(
      APIError
    )
  })
})

describe('handleClientRegistrationGate', () => {
  const register = { path: '/oauth2/register' }

  it('ignores every path other than /oauth2/register', async () => {
    const resolveSession = vi.fn()
    await handleClientRegistrationGate({ path: '/oauth2/token' }, resolveSession)
    expect(resolveSession).not.toHaveBeenCalled()
  })

  it('lets a cookie-less caller through to the OAuth provider (which applies the opt-in)', async () => {
    await expect(handleClientRegistrationGate(register, async () => null)).resolves.toBeUndefined()
    expect(mockPrincipalFindFirst).not.toHaveBeenCalled()
  })

  it.each(['user'])('allows a signed-in %s principal to register', async (type) => {
    mockPrincipalFindFirst.mockResolvedValue({ type })
    await expect(
      handleClientRegistrationGate(register, async () => ({ user: { id: 'user_1' } }))
    ).resolves.toBeUndefined()
  })

  it.each([
    ['an anonymous session', { type: 'anonymous' }],
    ['a session with no principal row', undefined],
  ])('refuses %s', async (_label, row) => {
    mockPrincipalFindFirst.mockResolvedValue(row)
    const err = await handleClientRegistrationGate(register, async () => ({
      user: { id: 'user_anon' },
    })).catch((e) => e)
    expect(err).toBeInstanceOf(APIError)
    expect((err as APIError).status).toBe('UNAUTHORIZED')
  })

  it('refuses (fails closed) when the principal lookup throws', async () => {
    mockPrincipalFindFirst.mockRejectedValue(new Error('db down'))
    await expect(
      handleClientRegistrationGate(register, async () => ({ user: { id: 'user_1' } }))
    ).rejects.toBeInstanceOf(APIError)
  })
})
