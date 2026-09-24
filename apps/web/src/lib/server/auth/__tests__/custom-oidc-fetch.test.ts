import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { genericOAuth } from 'better-auth/plugins'
import type { IdentityProvider } from '@/lib/server/domains/settings/identity-providers.service'

// Custom OIDC sign-in must fetch discovery / token / userinfo / refresh through
// `safeFetch`, as the SSO test handshake does. Mock only `safeFetch` and the
// DNS check of the discovered authorization endpoint, and keep the rest of the
// ssrf-guard module real, notably `SsrfError`, so a rejection here is the same
// object the production guard throws.
vi.mock('@/lib/server/content/ssrf-guard', async (orig) => {
  const actual = await orig<typeof import('@/lib/server/content/ssrf-guard')>()
  return { ...actual, safeFetch: vi.fn(), checkUrlSafety: vi.fn() }
})

import { checkUrlSafety, safeFetch, SsrfError } from '@/lib/server/content/ssrf-guard'
import { buildGenericOAuthConfigs, type GenericOAuthConfig } from '../build-oauth-configs'
import {
  clearOidcDiscoveryCache,
  createOidcEndpointSource,
  createPinnedUserInfo,
  DISCOVERY_TTL_MS,
  idTokenClaimProblem,
  resolveOidcDiscovery,
} from '../custom-oidc-fetch'
import {
  endpointReadingProviderId,
  pinCustomOidcFetches,
  resolveEndpointsForRoute,
} from '../custom-oidc-plugin'

const safeFetchMock = vi.mocked(safeFetch)
const checkUrlSafetyMock = vi.mocked(checkUrlSafety)

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
const CALLBACK = { path: '/oauth2/callback/:providerId', params: { providerId: 'sso' } }
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

/** The claims a valid ID token from DISCOVERY_DOC's issuer carries, plus `extra`. */
function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: DISCOVERY_DOC.issuer,
    aud: 'client-1',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...extra,
  }
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
  checkUrlSafetyMock.mockReset()
  checkUrlSafetyMock.mockResolvedValue({ safe: true, address: '93.184.216.34', family: 4 })
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
          id_token: idToken(claims({ sub: 'user-1' })),
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

  // OIDC Discovery 1.0 §3 / RFC 8414 §2: the token endpoint gets the code, the
  // client secret and refresh tokens, so a cleartext one is refused.
  it('rejects a discovery document whose token or authorization endpoint is plain http', async () => {
    safeFetchMock
      .mockResolvedValueOnce(
        json({ ...DISCOVERY_DOC, token_endpoint: 'http://idp.example.com/token' })
      )
      .mockResolvedValueOnce(
        json({ ...DISCOVERY_DOC, authorization_endpoint: 'http://idp.example.com/authorize' })
      )

    await expect(resolveOidcDiscovery(DISCOVERY_URL)).rejects.toThrow(/https/)
    await expect(resolveOidcDiscovery(DISCOVERY_URL)).rejects.toThrow(/https/)
  })

  it('drops a plain-http userinfo endpoint instead of sending the access token to it', async () => {
    safeFetchMock.mockResolvedValueOnce(
      json({ ...DISCOVERY_DOC, userinfo_endpoint: 'http://idp.example.com/userinfo' })
    )

    const endpoints = await resolveOidcDiscovery(DISCOVERY_URL)

    expect(endpoints.userinfoEndpoint).toBeUndefined()
    expect(endpoints.tokenEndpoint).toBe(DISCOVERY_DOC.token_endpoint)
  })

  // The save-time policy refuses a private authorizationUrl because it is where
  // the browser is sent; a discovered one gets the same DNS check.
  it('rejects a discovered authorization endpoint that resolves to a private address', async () => {
    safeFetchMock.mockResolvedValueOnce(json(DISCOVERY_DOC))
    checkUrlSafetyMock.mockResolvedValueOnce({ safe: false, reason: 'ssrf-rejected' })

    await expect(resolveOidcDiscovery(DISCOVERY_URL)).rejects.toThrow(/authorization_endpoint/)
    expect(checkUrlSafetyMock).toHaveBeenCalledWith(DISCOVERY_DOC.authorization_endpoint)
  })

  // A shared in-flight promise that never settled would block every sign-in
  // for the provider; the deadline makes it reject, and the next request
  // starts a fresh fetch.
  it('rejects a discovery fetch that never settles, then lets the next request retry', async () => {
    vi.useFakeTimers()
    safeFetchMock
      .mockReturnValueOnce(new Promise<Response>(() => {}))
      .mockResolvedValueOnce(json(DISCOVERY_DOC))

    const stuck = resolveOidcDiscovery(DISCOVERY_URL)
    const settled = expect(stuck).rejects.toThrow(/did not settle/)
    await vi.advanceTimersByTimeAsync(15_000)
    await settled

    vi.useRealTimers()
    await expect(resolveOidcDiscovery(DISCOVERY_URL)).resolves.toMatchObject({
      tokenEndpoint: DISCOVERY_DOC.token_endpoint,
    })
    expect(safeFetchMock).toHaveBeenCalledTimes(2)
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
        // A manual provider with no stored issuer: no `iss` to check.
        id_token: idToken(claims({ iss: undefined, sub: 'user-1', email: 'ada@acme.example' })),
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

  // The plugin's callback skips its RFC 9207 `iss` check when the `issuer`
  // getter reads undefined, and `getToken` resolves the endpoints again. The
  // hook must stop the callback itself, before any code is exchanged.
  it('fails a callback closed when the endpoints cannot be resolved', async () => {
    safeFetchMock
      .mockRejectedValueOnce(new SsrfError('dns-error'))
      .mockResolvedValueOnce(json(DISCOVERY_DOC))
    const { configs, byId } = await signInStack()

    await expect(resolveEndpointsForRoute(CALLBACK, byId)).resolves.toBe(
      'oauth_code_verification_failed'
    )
    // The route never runs, so the getter the plugin would read stays empty and
    // the later resolve that would have succeeded is never reached.
    expect(configs[0].issuer).toBeUndefined()
    expect(safeFetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps sign-in routes on the plugin configuration error when resolution fails', async () => {
    safeFetchMock.mockRejectedValueOnce(new SsrfError('dns-error'))
    const { byId } = await signInStack()

    await expect(resolveEndpointsForRoute(SIGN_IN, byId)).resolves.toBeUndefined()
  })

  it('checks the callback iss against the issuer the hook just resolved', async () => {
    safeFetchMock.mockResolvedValue(json(DISCOVERY_DOC))
    const { byId } = await signInStack()
    const withIss = (iss: unknown) => ({ ...CALLBACK, query: { code: 'code-1', iss } })

    await expect(resolveEndpointsForRoute(withIss('https://evil.example'), byId)).resolves.toBe(
      'issuer_mismatch'
    )
    await expect(resolveEndpointsForRoute(withIss(['a', 'b']), byId)).resolves.toBe(
      'issuer_mismatch'
    )
    await expect(
      resolveEndpointsForRoute(withIss(DISCOVERY_DOC.issuer), byId)
    ).resolves.toBeUndefined()
    // No `iss` parameter: RFC 9207 lets the IdP omit it.
    await expect(
      resolveEndpointsForRoute({ ...CALLBACK, query: { code: 'code-1' } }, byId)
    ).resolves.toBeUndefined()
    // The same check on Better-Auth's social callback route.
    await expect(
      resolveEndpointsForRoute(
        { path: '/callback/:id', params: { id: 'sso' }, query: { iss: 'https://evil.example' } },
        byId
      )
    ).resolves.toBe('issuer_mismatch')
  })

  describe('ID token claims (OIDC Core 3.1.3.7 steps 2, 3 and 9)', () => {
    const expected = { clientId: 'client-1', issuer: DISCOVERY_DOC.issuer }

    it('accepts a token for this client from the expected issuer', () => {
      expect(idTokenClaimProblem(claims(), expected)).toBeUndefined()
      expect(idTokenClaimProblem(claims({ aud: ['other', 'client-1'] }), expected)).toBeUndefined()
    })

    it('rejects the wrong issuer, audience or an expired token', () => {
      expect(idTokenClaimProblem(claims({ iss: 'https://evil.example' }), expected)).toMatch(/iss/)
      expect(idTokenClaimProblem(claims({ aud: 'other-client' }), expected)).toMatch(/aud/)
      expect(idTokenClaimProblem(claims({ aud: undefined }), expected)).toMatch(/aud/)
      expect(idTokenClaimProblem(claims({ exp: undefined }), expected)).toMatch(/exp/)
      const longExpired = Math.floor(Date.now() / 1000) - 3600
      expect(idTokenClaimProblem(claims({ exp: longExpired }), expected)).toMatch(/expired/)
    })

    // Entra's `common` / `organizations` discovery publishes this template.
    it("fills an Entra multi-tenant issuer template from the token's tid", () => {
      const entra = {
        clientId: 'client-1',
        issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
      }
      const tenant = '9188040d-6c67-4c5b-b112-36a304b66dad'

      expect(
        idTokenClaimProblem(
          claims({ iss: `https://login.microsoftonline.com/${tenant}/v2.0`, tid: tenant }),
          entra
        )
      ).toBeUndefined()
      expect(
        idTokenClaimProblem(
          claims({ iss: `https://login.microsoftonline.com/${tenant}/v2.0`, tid: 'other-tenant' }),
          entra
        )
      ).toMatch(/iss/)
      expect(
        idTokenClaimProblem(
          claims({ iss: `https://login.microsoftonline.com/${tenant}/v2.0` }),
          entra
        )
      ).toMatch(/iss/)
    })

    it('accepts both issuer forms Google documents for its ID tokens', () => {
      const google = { clientId: 'client-1', issuer: 'https://accounts.google.com' }

      expect(
        idTokenClaimProblem(claims({ iss: 'https://accounts.google.com' }), google)
      ).toBeUndefined()
      expect(idTokenClaimProblem(claims({ iss: 'accounts.google.com' }), google)).toBeUndefined()
      expect(idTokenClaimProblem(claims({ iss: 'accounts.google.com' }), expected)).toMatch(/iss/)
    })

    it('skips the issuer comparison only when no issuer is known', () => {
      expect(
        idTokenClaimProblem(claims({ iss: 'https://anything.example' }), { clientId: 'client-1' })
      ).toBeUndefined()
    })

    it('fails sign-in on a rejected ID token instead of trusting its claims', async () => {
      safeFetchMock.mockResolvedValueOnce(json(DISCOVERY_DOC))
      const { oauthProvider } = await signInStack()
      const sso = oauthProvider('sso')
      const withIdToken = (extra: Record<string, unknown>) => ({
        accessToken: 'access-1',
        idToken: idToken(claims({ sub: 'user-1', email: 'ada@acme.example', ...extra })),
      })

      await expect(
        sso.getUserInfo(withIdToken({ iss: 'https://evil.example' }))
      ).resolves.toBeNull()
      await expect(sso.getUserInfo(withIdToken({ aud: 'other-client' }))).resolves.toBeNull()
      await expect(sso.getUserInfo(withIdToken({ exp: 1 }))).resolves.toBeNull()
      await expect(
        sso.getUserInfo({ accessToken: 'access-1', idToken: 'not-a-jwt' })
      ).resolves.toBeNull()
      const accepted = await sso.getUserInfo(withIdToken({}))
      expect(accepted?.user).toMatchObject({ id: 'user-1', email: 'ada@acme.example' })
      // Discovery only; no userinfo fetch for any of these.
      expect(safeFetchMock).toHaveBeenCalledTimes(1)
    })
  })

  // OIDC Core 5.3.2: a userinfo response for a different subject is not used.
  it('rejects a userinfo response whose sub differs from the ID token', async () => {
    safeFetchMock
      .mockResolvedValueOnce(json(DISCOVERY_DOC))
      .mockResolvedValueOnce(json({ sub: 'someone-else', email: 'eve@acme.example' }))
      .mockResolvedValueOnce(json({ email: 'eve@acme.example' }))
    const { oauthProvider } = await signInStack()
    const sso = oauthProvider('sso')
    const tokens = { accessToken: 'access-1', idToken: idToken(claims({ sub: 'user-1' })) }

    await expect(sso.getUserInfo(tokens)).resolves.toBeNull()
    await expect(sso.getUserInfo(tokens)).resolves.toBeNull()
    expect(safeFetchMock).toHaveBeenCalledTimes(3)
  })

  it('uses the stored userinfo URL and issuer of a manual-endpoint provider', async () => {
    safeFetchMock.mockResolvedValueOnce(
      json({ sub: 'user-1', email: 'ada@acme.example', name: 'Ada' })
    )
    const endpoints = createOidcEndpointSource({
      authorizationUrl: 'https://manual.example.com/authorize',
      tokenUrl: 'https://manual.example.com/token',
      userInfoUrl: 'https://manual.example.com/userinfo',
      issuer: 'https://manual.example.com',
    })
    const getUserInfo = createPinnedUserInfo({ clientId: 'client-1', endpoints })

    expect(endpoints.peek()?.issuer).toBe('https://manual.example.com')
    await expect(
      getUserInfo({
        accessToken: 'access-1',
        idToken: idToken(claims({ sub: 'user-1', email: 'ada@acme.example' })),
      })
    ).resolves.toBeNull()
    const info = await getUserInfo({
      accessToken: 'access-1',
      idToken: idToken(claims({ iss: 'https://manual.example.com', sub: 'user-1' })),
    })

    expect(info).toMatchObject({ id: 'user-1', email: 'ada@acme.example' })
    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://manual.example.com/userinfo',
    ])
  })

  it('holds stored manual endpoints to the https rule discovered endpoints meet', async () => {
    const httpToken = createOidcEndpointSource({
      authorizationUrl: 'https://manual.example.com/authorize',
      tokenUrl: 'http://manual.example.com/token',
    })
    const httpAuthorize = createOidcEndpointSource({
      authorizationUrl: 'http://manual.example.com/authorize',
      tokenUrl: 'https://manual.example.com/token',
    })
    const httpUserinfo = createOidcEndpointSource({
      authorizationUrl: 'https://manual.example.com/authorize',
      tokenUrl: 'https://manual.example.com/token',
      userInfoUrl: 'http://manual.example.com/userinfo',
    })

    expect(httpToken.peek()).toBeUndefined()
    await expect(httpToken.resolve()).rejects.toThrow(/no discovery URL or manual endpoints/)
    expect(httpAuthorize.peek()).toBeUndefined()
    // A plain-http userinfo URL is dropped; the https endpoints still serve.
    expect(httpUserinfo.peek()).toEqual({
      authorizationEndpoint: 'https://manual.example.com/authorize',
      tokenEndpoint: 'https://manual.example.com/token',
    })
    const getUserInfo = createPinnedUserInfo({ clientId: 'client-1', endpoints: httpUserinfo })
    await expect(
      getUserInfo({ accessToken: 'access-1', idToken: idToken(claims({ sub: 'user-1' })) })
    ).resolves.toBeNull()
    expect(safeFetchMock).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // A discovery document read in clear could name any token endpoint, and the
  // code and client secret would follow it there.
  it('never fetches a plain-http discovery URL', async () => {
    const httpDiscovery = 'http://idp.example.com/.well-known/openid-configuration'
    const withManual = createOidcEndpointSource({
      discoveryUrl: httpDiscovery,
      authorizationUrl: 'https://manual.example.com/authorize',
      tokenUrl: 'https://manual.example.com/token',
    })

    await expect(resolveOidcDiscovery(httpDiscovery)).rejects.toThrow(/https/)
    // As with an unreachable document, the stored https endpoints are the fallback.
    await expect(withManual.resolve()).resolves.toMatchObject({
      tokenEndpoint: 'https://manual.example.com/token',
    })
    const discoveryOnly = createOidcEndpointSource({ discoveryUrl: httpDiscovery })
    await expect(discoveryOnly.resolve()).rejects.toThrow(/https/)
    expect(safeFetchMock).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // `backfill-custom-oidc-provider.ts` copies a legacy credential's endpoint
  // URLs as they are, without the save-time https schema. A row it wrote must
  // not become a way to send the code and client secret in clear.
  it('gives a backfilled provider with a plain-http token URL no endpoints to sign in with', async () => {
    const { configs, oauthProvider } = await signInStack([
      provider({
        registrationId: 'custom-oidc',
        discoveryUrl: null,
        authorizationUrl: 'https://legacy.example.com/authorize',
        tokenUrl: 'http://legacy.example.com/token',
      }),
    ])

    expect(configs[0].authorizationUrl).toBeUndefined()
    expect(configs[0].tokenUrl).toBeUndefined()
    await expect(oauthProvider('custom-oidc').validateAuthorizationCode(CODE)).rejects.toThrow(
      /no discovery URL or manual endpoints/
    )
    expect(safeFetchMock).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
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
