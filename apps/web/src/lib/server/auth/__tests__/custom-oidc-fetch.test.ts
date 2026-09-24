import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { genericOAuth } from 'better-auth/plugins'
import type { IdentityProvider } from '@/lib/server/domains/settings/identity-providers.service'

// Custom OIDC sign-in must fetch discovery / token / userinfo / refresh through
// `safeFetch`, as the SSO test handshake does. Mock only `safeFetch` and keep
// the rest of the ssrf-guard module real, notably `SsrfError`, so a rejection
// here is the same object the production guard throws.
vi.mock('@/lib/server/content/ssrf-guard', async (orig) => {
  const actual = await orig<typeof import('@/lib/server/content/ssrf-guard')>()
  return { ...actual, safeFetch: vi.fn() }
})

import { safeFetch, SsrfError } from '@/lib/server/content/ssrf-guard'
import { buildGenericOAuthConfigs, type GenericOAuthConfig } from '../build-oauth-configs'
import {
  clearOidcDiscoveryCache,
  DISCOVERY_TTL_MS,
  resolveOidcDiscovery,
} from '../custom-oidc-fetch'
import {
  endpointReadingProviderId,
  pinCustomOidcFetches,
  resolveEndpointsForRoute,
} from '../custom-oidc-plugin'

const safeFetchMock = vi.mocked(safeFetch)

const BASE_URL = 'https://qb.example/api/auth'
const DISCOVERY_URL = 'https://idp.example.com/.well-known/openid-configuration'
const DISCOVERY_DOC = {
  issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
  jwks_uri: 'https://idp.example.com/jwks',
}
const SIGN_IN = { path: '/sign-in/oauth2', body: { providerId: 'sso' } }
const AUTHORIZE = {
  state: 'state-1',
  codeVerifier: 'v'.repeat(43),
  redirectURI: `${BASE_URL}/oauth2/callback/sso`,
}
const CODE = { code: 'code-1', codeVerifier: 'v'.repeat(43), redirectURI: AUTHORIZE.redirectURI }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A compact JWS with the given claims. Only decoded, never verified. */
function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.c2ln`
}

function provider(overrides: Partial<IdentityProvider> = {}): IdentityProvider {
  return {
    id: 'idp_1',
    registrationId: 'sso',
    enabled: true,
    autoCreateUsers: true,
    clientId: 'client-1',
    scopes: null,
    discoveryUrl: DISCOVERY_URL,
    authorizationUrl: null,
    tokenUrl: null,
    ...overrides,
  } as unknown as IdentityProvider
}

/** Build production configs, wrap the real plugin, and run its `init`. */
async function signInStack(providers: IdentityProvider[] = [provider()]) {
  const configs = await buildGenericOAuthConfigs({
    providers,
    creds: async () => ({ clientSecret: 'secret-1' }),
    tierAllowsOidc: true,
  })
  const plugin = pinCustomOidcFetches(genericOAuth({ config: configs }), configs)
  const { context } = plugin.init({ socialProviders: [], baseURL: BASE_URL } as never)
  const byId = new Map(configs.map((c) => [c.providerId, c]))
  const oauthProvider = (id: string) => {
    const found = context.socialProviders.find((p) => p.id === id)
    if (!found) throw new Error(`provider ${id} not registered`)
    return found
  }
  return { configs, plugin, byId, oauthProvider }
}

function refresh(p: { refreshAccessToken?: (token: string) => Promise<unknown> }) {
  if (!p.refreshAccessToken) throw new Error('provider has no refreshAccessToken')
  return p.refreshAccessToken('refresh-1')
}

function formBody(call: number): URLSearchParams {
  return new URLSearchParams(safeFetchMock.mock.calls[call][1]?.body ?? '')
}

// The plugin's own fetches use the global fetch. Any call to it on the
// custom-OIDC path is an unpinned server-side fetch, so every test asserts it
// never happened.
const fetchSpy = vi.spyOn(globalThis, 'fetch')

beforeEach(() => {
  safeFetchMock.mockReset()
  clearOidcDiscoveryCache()
  fetchSpy.mockReset()
  fetchSpy.mockImplementation(async () => {
    throw new Error('unpinned global fetch')
  })
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  fetchSpy.mockRestore()
})

describe('custom OIDC runtime fetches', () => {
  it('never hands the plugin a discoveryUrl and does no network at build', async () => {
    const { configs } = await signInStack()

    expect(configs).toHaveLength(1)
    expect('discoveryUrl' in configs[0]).toBe(false)
    expect(configs[0].authorizationUrl).toBeUndefined()
    expect(configs[0].tokenUrl).toBeUndefined()
    expect(safeFetchMock).not.toHaveBeenCalled()
  })

  it('resolves discovery through safeFetch before sign-in reads the endpoints', async () => {
    safeFetchMock.mockResolvedValueOnce(json(DISCOVERY_DOC))
    const { configs, byId, oauthProvider } = await signInStack()

    await resolveEndpointsForRoute(SIGN_IN, byId)

    expect(safeFetchMock).toHaveBeenCalledTimes(1)
    expect(safeFetchMock.mock.calls[0][0]).toBe(DISCOVERY_URL)
    expect(configs[0].authorizationUrl).toBe(DISCOVERY_DOC.authorization_endpoint)
    expect(configs[0].tokenUrl).toBe(DISCOVERY_DOC.token_endpoint)
    expect(configs[0].issuer).toBe(DISCOVERY_DOC.issuer)

    const url = await oauthProvider('sso').createAuthorizationURL(AUTHORIZE)
    expect(url.toString().startsWith(DISCOVERY_DOC.authorization_endpoint)).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('exchanges the code, reads userinfo and refreshes only through safeFetch', async () => {
    safeFetchMock
      .mockResolvedValueOnce(json(DISCOVERY_DOC))
      .mockResolvedValueOnce(
        json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          // No email claim, so user info comes from the userinfo endpoint.
          id_token: idToken({ sub: 'user-1', iss: DISCOVERY_DOC.issuer }),
        })
      )
      .mockResolvedValueOnce(
        json({ sub: 'user-1', email: 'ada@acme.example', email_verified: true, name: 'Ada' })
      )
      .mockResolvedValueOnce(json({ access_token: 'access-2', expires_in: 3600 }))
    const { byId, oauthProvider } = await signInStack()
    const sso = oauthProvider('sso')

    await resolveEndpointsForRoute(SIGN_IN, byId)
    const tokens = await sso.validateAuthorizationCode(CODE)
    if (!tokens) throw new Error('expected tokens')
    const info = await sso.getUserInfo(tokens)
    const refreshed = await refresh(sso)

    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([
      DISCOVERY_URL,
      DISCOVERY_DOC.token_endpoint,
      DISCOVERY_DOC.userinfo_endpoint,
      DISCOVERY_DOC.token_endpoint,
    ])

    expect(safeFetchMock.mock.calls[1][1]?.method).toBe('POST')
    const exchange = formBody(1)
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('code-1')
    expect(exchange.get('code_verifier')).toBe(CODE.codeVerifier)
    expect(exchange.get('redirect_uri')).toBe(CODE.redirectURI)
    expect(exchange.get('client_id')).toBe('client-1')
    expect(exchange.get('client_secret')).toBe('secret-1')
    expect(tokens.accessToken).toBe('access-1')

    expect(safeFetchMock.mock.calls[2][1]?.headers?.Authorization).toBe('Bearer access-1')
    expect(info?.user).toMatchObject({ id: 'user-1', email: 'ada@acme.example' })

    const refreshBody = formBody(3)
    expect(refreshBody.get('grant_type')).toBe('refresh_token')
    expect(refreshBody.get('refresh_token')).toBe('refresh-1')
    expect(refreshed).toMatchObject({ accessToken: 'access-2' })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails sign-in closed when the discovery URL resolves to a private address', async () => {
    safeFetchMock.mockRejectedValue(new SsrfError('ssrf-rejected'))
    const { configs, byId, oauthProvider } = await signInStack()
    const sso = oauthProvider('sso')

    await resolveEndpointsForRoute(SIGN_IN, byId)

    expect(configs[0].authorizationUrl).toBeUndefined()
    expect(configs[0].tokenUrl).toBeUndefined()
    await expect(sso.createAuthorizationURL(AUTHORIZE)).rejects.toThrow()
    await expect(sso.validateAuthorizationCode(CODE)).rejects.toBeInstanceOf(SsrfError)
    await expect(refresh(sso)).rejects.toBeInstanceOf(SsrfError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails closed when an endpoint rebinds to a private address after discovery', async () => {
    safeFetchMock
      .mockResolvedValueOnce(json(DISCOVERY_DOC))
      .mockRejectedValue(new SsrfError('ssrf-rejected'))
    const { byId, oauthProvider } = await signInStack()
    const sso = oauthProvider('sso')

    await resolveEndpointsForRoute(SIGN_IN, byId)

    await expect(sso.validateAuthorizationCode(CODE)).rejects.toBeInstanceOf(SsrfError)
    await expect(sso.getUserInfo({ accessToken: 'access-1' })).resolves.toBeNull()
    await expect(refresh(sso)).rejects.toBeInstanceOf(SsrfError)
    expect(safeFetchMock).toHaveBeenCalledTimes(4)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('re-fetches an expired discovery document, and a rejected re-fetch fails closed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    safeFetchMock
      .mockResolvedValueOnce(json(DISCOVERY_DOC))
      .mockRejectedValue(new SsrfError('ssrf-rejected'))
    const { configs, byId, oauthProvider } = await signInStack()

    await resolveEndpointsForRoute(SIGN_IN, byId)
    expect(configs[0].authorizationUrl).toBe(DISCOVERY_DOC.authorization_endpoint)

    vi.setSystemTime(Date.now() + DISCOVERY_TTL_MS)
    expect(configs[0].authorizationUrl).toBeUndefined()

    await resolveEndpointsForRoute(SIGN_IN, byId)
    expect(safeFetchMock).toHaveBeenCalledTimes(2)
    expect(configs[0].authorizationUrl).toBeUndefined()
    await expect(oauthProvider('sso').createAuthorizationURL(AUTHORIZE)).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a discovery document whose endpoints are not http(s) URLs', async () => {
    safeFetchMock.mockResolvedValueOnce(
      json({ ...DISCOVERY_DOC, token_endpoint: 'file:///etc/passwd' })
    )

    await expect(resolveOidcDiscovery(DISCOVERY_URL)).rejects.toThrow(/token_endpoint/)
  })

  it('shares one discovery fetch between concurrent requests', async () => {
    safeFetchMock.mockResolvedValueOnce(json(DISCOVERY_DOC))

    const [a, b] = await Promise.all([
      resolveOidcDiscovery(DISCOVERY_URL),
      resolveOidcDiscovery(DISCOVERY_URL),
    ])

    expect(a).toEqual(b)
    expect(safeFetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends manual-endpoint providers to the stored token URL through safeFetch', async () => {
    safeFetchMock.mockResolvedValueOnce(
      json({
        access_token: 'access-1',
        id_token: idToken({ sub: 'user-1', email: 'ada@acme.example' }),
      })
    )
    const { configs, oauthProvider } = await signInStack([
      provider({
        discoveryUrl: null,
        authorizationUrl: 'https://manual.example.com/authorize',
        tokenUrl: 'https://manual.example.com/token',
      }),
    ])
    const sso = oauthProvider('sso')

    expect(configs[0].authorizationUrl).toBe('https://manual.example.com/authorize')
    expect(configs[0].issuer).toBeUndefined()
    const tokens = await sso.validateAuthorizationCode(CODE)
    if (!tokens) throw new Error('expected tokens')
    const info = await sso.getUserInfo(tokens)

    expect(safeFetchMock).toHaveBeenCalledTimes(1)
    expect(safeFetchMock.mock.calls[0][0]).toBe('https://manual.example.com/token')
    expect(info?.user).toMatchObject({ id: 'user-1', email: 'ada@acme.example' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses refresh for a custom provider without a pinned refresh', async () => {
    const bare: GenericOAuthConfig = {
      providerId: 'bare',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      authorizationUrl: 'https://idp.example.com/authorize',
      tokenUrl: 'https://idp.example.com/token',
    }
    const plugin = pinCustomOidcFetches(genericOAuth({ config: [bare] }), [bare])
    const { context } = plugin.init({ socialProviders: [], baseURL: BASE_URL } as never)
    const found = context.socialProviders.find((p) => p.id === 'bare')
    if (!found) throw new Error('provider not registered')

    await expect(refresh(found)).rejects.toThrow(/refused/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('leaves built-in social providers untouched', async () => {
    const googleRefresh = vi.fn()
    const google = { id: 'google', refreshAccessToken: googleRefresh }
    const configs = await buildGenericOAuthConfigs({
      providers: [provider()],
      creds: async () => ({ clientSecret: 'secret-1' }),
      tierAllowsOidc: true,
    })
    const plugin = pinCustomOidcFetches(genericOAuth({ config: configs }), configs)

    const { context } = plugin.init({ socialProviders: [google], baseURL: BASE_URL } as never)

    expect(context.socialProviders.map((p) => p.id)).toEqual(['sso', 'google'])
    expect(google.refreshAccessToken).toBe(googleRefresh)
  })

  it('resolves endpoints on every route that reads them, and only those', async () => {
    const { plugin } = await signInStack()
    const hooks = (
      plugin as unknown as { hooks?: { before?: Array<{ matcher: (c: object) => boolean }> } }
    ).hooks?.before
    expect(hooks).toHaveLength(1)
    const matches = (ctx: object) => hooks?.[0].matcher(ctx)

    expect(endpointReadingProviderId(SIGN_IN)).toBe('sso')
    expect(
      endpointReadingProviderId({
        path: '/oauth2/callback/:providerId',
        params: { providerId: 'sso' },
      })
    ).toBe('sso')
    expect(endpointReadingProviderId({ path: '/callback/:id', params: { id: 'sso' } })).toBe('sso')
    expect(endpointReadingProviderId({ path: '/sign-in/social', body: { provider: 'sso' } })).toBe(
      'sso'
    )
    expect(endpointReadingProviderId({ path: '/get-session' })).toBeUndefined()
    expect(matches(SIGN_IN)).toBe(true)
    expect(matches({ path: '/sign-in/social', body: { provider: 'google' } })).toBe(false)
    expect(matches({ path: '/sign-in/email', body: { email: 'a@b.co' } })).toBe(false)
  })

  // Control: proves the global-fetch spy above would catch the leak this fix
  // closes. The stock plugin, given a discoveryUrl, fetches it unpinned.
  it('control: the unpinned plugin fetches discovery with the global fetch', async () => {
    fetchSpy.mockImplementation(async () => json(DISCOVERY_DOC))
    const raw = genericOAuth({
      config: [
        {
          providerId: 'raw',
          discoveryUrl: DISCOVERY_URL,
          clientId: 'client-1',
          clientSecret: 'secret-1',
        },
      ],
    })
    const { context } = raw.init({ socialProviders: [], baseURL: BASE_URL } as never)
    const found = context.socialProviders.find((p) => p.id === 'raw')
    if (!found) throw new Error('provider not registered')

    await found.createAuthorizationURL(AUTHORIZE)

    expect(fetchSpy).toHaveBeenCalled()
    expect(String(fetchSpy.mock.calls[0][0])).toContain(DISCOVERY_URL)
    expect(safeFetchMock).not.toHaveBeenCalled()
  })
})
