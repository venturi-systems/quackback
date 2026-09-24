// @vitest-environment node
//
// End-to-end custom-OIDC sign-in through a real Better-Auth instance and its
// HTTP handler. The unit tests in custom-oidc-fetch.test.ts drive the provider
// methods and the hook directly; these prove the wiring they rely on: the
// before-hook sees the route template with its params, query and body, the
// plugin's routes read the pinned getters, and a callback that fails the
// pinned checks never reaches the code exchange. The last block does the same
// for a self-hosted GitLab social provider pinned by `pinSelfHostedGitlab`.
// The node environment gives the undici Request/Response the Better-Auth
// router is built on.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { genericOAuth } from 'better-auth/plugins'
import type { IdentityProvider } from '@/lib/server/domains/settings/identity-providers.service'

vi.mock('@/lib/server/content/ssrf-guard', async (orig) => {
  const actual = await orig<typeof import('@/lib/server/content/ssrf-guard')>()
  return { ...actual, safeFetch: vi.fn(), checkUrlSafety: vi.fn() }
})

import { checkUrlSafety, safeFetch, SsrfError } from '@/lib/server/content/ssrf-guard'
import { buildGenericOAuthConfigs } from '../build-oauth-configs'
import { clearOidcDiscoveryCache, DISCOVERY_TTL_MS } from '../custom-oidc-fetch'
import { pinCustomOidcFetches } from '../custom-oidc-plugin'
import { pinSelfHostedGitlab } from '../self-hosted-gitlab'

const safeFetchMock = vi.mocked(safeFetch)
const checkUrlSafetyMock = vi.mocked(checkUrlSafety)

const ORIGIN = 'https://qb.example'
const BASE_URL = `${ORIGIN}/api/auth`
const DISCOVERY_URL = 'https://idp.example.com/.well-known/openid-configuration'
const DISCOVERY_DOC = {
  issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
}

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

function tokenResponse(): Response {
  return json({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    id_token: idToken({
      iss: DISCOVERY_DOC.issuer,
      aud: 'client-1',
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: 'user-1',
      email: 'ada@acme.example',
      email_verified: true,
      name: 'Ada',
    }),
  })
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

/** A Better-Auth instance wired exactly as `createAuth` wires custom OIDC. */
async function createTestAuth(overrides: Partial<IdentityProvider> = {}) {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  }
  const configs = await buildGenericOAuthConfigs({
    providers: [provider(overrides)],
    creds: async () => ({ clientSecret: 'secret-1' }),
    tierAllowsOidc: true,
  })
  const auth = betterAuth({
    baseURL: ORIGIN,
    secret: 'custom-oidc-sign-in-test-secret-0123456789abcdef',
    database: memoryAdapter(db),
    telemetry: { enabled: false },
    plugins: [pinCustomOidcFetches(genericOAuth({ config: configs }), configs)],
  })
  return { auth, db }
}

type TestAuth = Awaited<ReturnType<typeof createTestAuth>>['auth']

function signIn(auth: TestAuth): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/sign-in/oauth2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ providerId: 'sso', disableRedirect: true }),
    })
  )
}

function callback(auth: TestAuth, query: Record<string, string>, cookie?: string) {
  return auth.handler(
    new Request(`${BASE_URL}/oauth2/callback/sso?${new URLSearchParams(query)}`, {
      headers: cookie ? { cookie } : {},
    })
  )
}

/** The Cookie header a browser would send back after `res`. */
function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

// Any global fetch on these paths is an unpinned server-side fetch.
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

describe('custom OIDC sign-in through the Better-Auth handler', () => {
  it('signs in end to end with every IdP fetch pinned through safeFetch', async () => {
    safeFetchMock.mockResolvedValueOnce(json(DISCOVERY_DOC)).mockResolvedValueOnce(tokenResponse())
    const { auth, db } = await createTestAuth()

    const start = await signIn(auth)
    expect(start.status).toBe(200)
    const { url } = (await start.json()) as { url: string }
    const authorize = new URL(url)
    expect(`${authorize.origin}${authorize.pathname}`).toBe(DISCOVERY_DOC.authorization_endpoint)
    const state = authorize.searchParams.get('state')
    if (!state) throw new Error('authorization URL has no state')

    const done = await callback(
      auth,
      { code: 'code-1', state, iss: DISCOVERY_DOC.issuer },
      cookiesFrom(start)
    )

    expect(done.status).toBe(302)
    expect(done.headers.get('location')).not.toContain('error=')
    // Discovery once (cached for the callback), then the code exchange. The
    // ID token carries the email, so there is no userinfo fetch.
    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([
      DISCOVERY_URL,
      DISCOVERY_DOC.token_endpoint,
    ])
    expect(new URLSearchParams(safeFetchMock.mock.calls[1][1]?.body).get('code')).toBe('code-1')
    expect(db.user.map((u) => u.email)).toEqual(['ada@acme.example'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('redirects a callback whose iss differs from the issuer, before exchanging the code', async () => {
    safeFetchMock.mockResolvedValueOnce(json(DISCOVERY_DOC)).mockResolvedValueOnce(tokenResponse())
    const { auth, db } = await createTestAuth()

    const res = await callback(auth, {
      code: 'code-1',
      state: 'state-1',
      iss: 'https://evil.example',
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${BASE_URL}/error?error=issuer_mismatch`)
    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([DISCOVERY_URL])
    expect(db.user).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // The window this closes: the callback's own resolve fails, so the plugin
  // would read no issuer and skip its `iss` check, while the pinned getToken's
  // resolve moments later succeeds and exchanges the code.
  it('fails the callback closed when discovery fails there, even if it would succeed next', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    safeFetchMock
      .mockResolvedValueOnce(json(DISCOVERY_DOC))
      .mockRejectedValueOnce(new SsrfError('dns-error'))
      .mockResolvedValueOnce(json(DISCOVERY_DOC))
      .mockResolvedValueOnce(tokenResponse())
    const { auth, db } = await createTestAuth()

    const start = await signIn(auth)
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')
    if (!state) throw new Error('authorization URL has no state')
    // The discovery document expires between sign-in and callback.
    vi.setSystemTime(Date.now() + DISCOVERY_TTL_MS)

    const res = await callback(
      auth,
      { code: 'code-1', state, iss: 'https://evil.example' },
      cookiesFrom(start)
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${BASE_URL}/error?error=oauth_code_verification_failed`
    )
    // Sign-in's discovery, then the callback's failed re-fetch. No code exchange.
    expect(safeFetchMock).toHaveBeenCalledTimes(2)
    expect(db.user).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not follow a redirect from the discovery URL', async () => {
    safeFetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    )
    const { auth } = await createTestAuth()

    const res = await signIn(auth)

    expect(res.status).toBe(400)
    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([DISCOVERY_URL])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // Here the real safeFetch runs: the metadata address is refused by the SSRF
  // guard itself, not by a mocked rejection. An IP literal resolves locally.
  it('refuses a discovery URL on a private address with the real SSRF guard', async () => {
    const actual = await vi.importActual<typeof import('@/lib/server/content/ssrf-guard')>(
      '@/lib/server/content/ssrf-guard'
    )
    safeFetchMock.mockImplementation(actual.safeFetch)
    const metadataUrl = 'https://169.254.169.254/.well-known/openid-configuration'
    const { auth, db } = await createTestAuth({ discoveryUrl: metadataUrl })

    const start = await signIn(auth)
    const done = await callback(auth, { code: 'code-1', state: 'state-1' })

    expect(start.status).toBe(400)
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe(
      `${BASE_URL}/error?error=oauth_code_verification_failed`
    )
    await expect(actual.safeFetch(metadataUrl)).rejects.toMatchObject({
      name: 'SsrfError',
      reason: 'ssrf-rejected',
    })
    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([metadataUrl, metadataUrl])
    expect(db.user).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('self-hosted GitLab through a real Better-Auth instance', () => {
  const GITLAB_ISSUER = 'https://gitlab.acme.example'

  /** A Better-Auth instance wired as `createAuth` wires a self-hosted GitLab. */
  function createGitlabAuth() {
    const db: Record<string, Record<string, unknown>[]> = {
      user: [],
      session: [],
      account: [],
      verification: [],
    }
    const auth = betterAuth({
      baseURL: ORIGIN,
      secret: 'custom-oidc-sign-in-test-secret-0123456789abcdef',
      database: memoryAdapter(db),
      telemetry: { enabled: false },
      socialProviders: {
        gitlab: { clientId: 'gl-client', clientSecret: 'gl-secret', issuer: GITLAB_ISSUER },
      },
      plugins: [pinSelfHostedGitlab()],
    })
    return { auth, db }
  }

  it('registers the pin plugin and sends every GitLab fetch through safeFetch', async () => {
    safeFetchMock
      .mockResolvedValueOnce(
        json({ access_token: 'gl-access-1', refresh_token: 'gl-refresh-1', token_type: 'bearer' })
      )
      .mockResolvedValueOnce(
        json({ id: 42, state: 'active', name: 'Ada', username: 'ada', email: 'ada@acme.example' })
      )
      .mockResolvedValueOnce(json({ access_token: 'gl-access-2', expires_in: 3600 }))
    const { auth, db } = createGitlabAuth()

    const ctx = await auth.$context
    expect(ctx.hasPlugin('pinned-self-hosted-gitlab')).toBe(true)

    const start = await auth.handler(
      new Request(`${BASE_URL}/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ provider: 'gitlab', disableRedirect: true }),
      })
    )
    expect(start.status).toBe(200)
    const authorize = new URL(((await start.json()) as { url: string }).url)
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${GITLAB_ISSUER}/oauth/authorize`)
    const state = authorize.searchParams.get('state')
    if (!state) throw new Error('authorization URL has no state')

    const query = new URLSearchParams({ code: 'gl-code-1', state })
    const done = await auth.handler(
      new Request(`${BASE_URL}/callback/gitlab?${query}`, {
        headers: { cookie: cookiesFrom(start) },
      })
    )
    const gitlab = ctx.socialProviders.find((p) => p.id === 'gitlab')
    if (!gitlab?.refreshAccessToken) throw new Error('gitlab provider has no refresh')
    const refreshed = await gitlab.refreshAccessToken('gl-refresh-1')

    expect(done.status).toBe(302)
    expect(done.headers.get('location')).not.toContain('error=')
    // The code exchange, the user lookup, then the refresh: every one pinned.
    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${GITLAB_ISSUER}/oauth/token`,
      `${GITLAB_ISSUER}/api/v4/user`,
      `${GITLAB_ISSUER}/oauth/token`,
    ])
    expect(new URLSearchParams(safeFetchMock.mock.calls[0][1]?.body).get('code')).toBe('gl-code-1')
    expect(db.user.map((u) => u.email)).toEqual(['ada@acme.example'])
    expect(refreshed.accessToken).toBe('gl-access-2')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
