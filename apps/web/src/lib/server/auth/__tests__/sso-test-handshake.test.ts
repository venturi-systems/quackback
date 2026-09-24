import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose'
import { runHandshake, type HandshakeInput } from '../sso-test-handshake'

// runHandshake fetches discovery / token / JWKS / userinfo through
// `safeFetch`, and DNS-checks a discovered authorization endpoint with
// `checkUrlSafety`. Mock only those two and keep the rest of the
// ssrf-guard module real — notably `SsrfError`, so the `instanceof`
// branches inside the handshake resolve against the real class.
vi.mock('@/lib/server/content/ssrf-guard', async (orig) => {
  const actual = await orig<typeof import('@/lib/server/content/ssrf-guard')>()
  return { ...actual, safeFetch: vi.fn(), checkUrlSafety: vi.fn() }
})

import { checkUrlSafety, safeFetch, SsrfError } from '@/lib/server/content/ssrf-guard'
const safeFetchMock = vi.mocked(safeFetch)
const checkUrlSafetyMock = vi.mocked(checkUrlSafety)

const baseInput: HandshakeInput = {
  state: 'state123',
  code: 'authcode456',
  discoveryUrl: 'https://idp.example/.well-known/openid-configuration',
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'https://qb/api/auth/oauth2/callback/sso',
  codeVerifier: 'test-code-verifier',
  expectedNonce: 'nonce789',
  expectedState: 'state123',
}

beforeEach(() => {
  safeFetchMock.mockReset()
  checkUrlSafetyMock.mockReset()
  checkUrlSafetyMock.mockResolvedValue({ safe: true, address: '93.184.216.34', family: 4 })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// A real signing key, so the handshake's jwtVerify runs for real: these tests
// cover what happens after the signature check, where the issuer is compared.
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let publicJwk: JWK
beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }
})

/** An ID token signed for `baseInput`, carrying `claims`. */
function signedIdToken(claims: JWTPayload): Promise<string> {
  return new SignJWT({
    sub: 'user-1',
    email: 'ada@acme.example',
    nonce: baseInput.expectedNonce,
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setAudience(baseInput.clientId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey)
}

const IDP = {
  authorization_endpoint: 'https://idp.example/authorize',
  token_endpoint: 'https://idp.example/token',
  jwks_uri: 'https://idp.example/jwks',
}

/** Queue discovery, token and JWKS responses for one full handshake. */
function idpResponds(discovery: Record<string, unknown>, idToken: string) {
  safeFetchMock
    .mockResolvedValueOnce(json({ ...IDP, ...discovery }))
    .mockResolvedValueOnce(json({ id_token: idToken, access_token: 'access-1' }))
    .mockResolvedValueOnce(json({ keys: [publicJwk] }))
}

describe('runHandshake', () => {
  it('rejects on state mismatch before any network call', async () => {
    const result = await runHandshake({ ...baseInput, state: 'wrong' })
    if (result.ok) throw new Error('expected failure')
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('state-validation')
    expect(safeFetchMock).not.toHaveBeenCalled()
  })

  it('surfaces IdP error codes from authorize step', async () => {
    const result = await runHandshake({
      ...baseInput,
      code: null,
      idpError: 'access_denied',
      idpErrorDescription: 'User declined',
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('idp-authorize')
    expect(result.errorCode).toBe('access_denied')
  })

  it('rejects when the discoveryUrl fails the SSRF check', async () => {
    // safeFetch validates the URL and throws SsrfError before dialling.
    safeFetchMock.mockRejectedValueOnce(new SsrfError('ssrf-rejected'))

    const result = await runHandshake(baseInput)

    if (result.ok) throw new Error('expected failure')
    expect(result.stage).toBe('discovery-fetch')
    expect(result.hint).toMatch(/not safe to fetch/i)
    expect(safeFetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns a structured discovery-fetch failure when the fetch throws', async () => {
    safeFetchMock.mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'))

    const result = await runHandshake(baseInput)

    if (result.ok) throw new Error('expected failure')
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('discovery-fetch')
    expect(result.hint).toMatch(/ECONNRESET|fetch failed|could not be reached/i)
  })

  it('surfaces token-exchange error with human hint', async () => {
    safeFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer: 'https://idp',
          authorization_endpoint: 'https://idp/authorize',
          token_endpoint: 'https://idp/token',
          jwks_uri: 'https://idp/jwks',
        }),
        { status: 200 }
      )
    )
    safeFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired' }), {
        status: 400,
      })
    )
    const result = await runHandshake(baseInput)
    if (result.ok) throw new Error('expected failure')
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('token-exchange')
    expect(result.errorCode).toBe('invalid_grant')
    expect(result.hint).toMatch(/PKCE|code reuse|expired|redirect URI/i)
  })

  it('surfaces the full ID token payload (allClaims) on success, including non-standard claims', async () => {
    // Upstream v0.13.0 test, rewritten onto this file's IdP helpers: the fork's
    // handshake also requires the discovered authorization endpoint to be an
    // https URL on a public address, which the helpers' discovery document has.
    const issuer = 'https://idp.example'
    idpResponds(
      { issuer },
      await signedIdToken({
        iss: issuer,
        sub: 'user-sub-123',
        email: 'alice@idp.example',
        name: 'Alice Example',
        // The non-standard claim the curated `claims` view drops but admins need.
        groups: ['11111111-2222-3333-4444-555555555555', 'feedback-admins'],
      })
    )

    const result = await runHandshake(baseInput)
    if (!result.ok) throw new Error(`expected success, got ${result.stage}: ${result.hint}`)

    // The curated subset still works for the friendly display + identity match.
    expect(result.claims.email).toBe('alice@idp.example')
    // ...and the full payload is surfaced verbatim, including `groups`.
    expect(result.allClaims).toBeDefined()
    expect(result.allClaims?.groups).toEqual([
      '11111111-2222-3333-4444-555555555555',
      'feedback-admins',
    ])
    expect(result.allClaims?.iss).toBe(issuer)
    expect(result.allClaims?.sub).toBe('user-sub-123')
  })
})

// The admin test must pass exactly when production sign-in would, so it checks
// `iss` with the same `acceptedIssuers` rule `idTokenClaimProblem` uses.
describe('runHandshake issuer check', () => {
  const ENTRA_TEMPLATE = 'https://login.microsoftonline.com/{tenantid}/v2.0'
  const TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'

  it("accepts an Entra multi-tenant issuer filled in from the token's tid", async () => {
    const iss = `https://login.microsoftonline.com/${TENANT}/v2.0`
    idpResponds({ issuer: ENTRA_TEMPLATE }, await signedIdToken({ iss, tid: TENANT }))

    const result = await runHandshake(baseInput)

    if (!result.ok) throw new Error(`expected success, got ${result.stage}: ${result.hint}`)
    expect(result.claims.iss).toBe(iss)
    expect(result.steps).toContainEqual(
      expect.objectContaining({ ok: true, stage: 'claim-check', label: 'Issuer matched' })
    )
  })

  it("accepts Google's bare accounts.google.com issuer", async () => {
    idpResponds(
      { issuer: 'https://accounts.google.com' },
      await signedIdToken({ iss: 'accounts.google.com' })
    )

    const result = await runHandshake(baseInput)

    if (!result.ok) throw new Error(`expected success, got ${result.stage}: ${result.hint}`)
    expect(result.claims.iss).toBe('accounts.google.com')
  })

  it('still accepts an exact issuer match', async () => {
    idpResponds(
      { issuer: 'https://idp.example' },
      await signedIdToken({ iss: 'https://idp.example' })
    )

    const result = await runHandshake(baseInput)

    expect(result.ok).toBe(true)
  })

  it.each<[string, string, JWTPayload]>([
    ['a different issuer', 'https://idp.example', { iss: 'https://evil.example' }],
    [
      'an Entra token whose iss names a tenant other than its tid',
      ENTRA_TEMPLATE,
      { iss: 'https://login.microsoftonline.com/other-tenant/v2.0', tid: TENANT },
    ],
    [
      'an Entra template token with no tid',
      ENTRA_TEMPLATE,
      { iss: `https://login.microsoftonline.com/${TENANT}/v2.0` },
    ],
    ['a token with no iss', 'https://idp.example', {}],
  ])('fails the claim check for %s, as sign-in does', async (_name, issuer, claims) => {
    idpResponds({ issuer }, await signedIdToken(claims))

    const result = await runHandshake(baseInput)

    if (result.ok) throw new Error('expected failure')
    expect(result.stage).toBe('claim-check')
    expect(result.hint).toMatch(/issuer/)
  })
})

describe('runHandshake https rule', () => {
  it.each<[string, Record<string, string>]>([
    ['token endpoint', { token_endpoint: 'http://idp.example/token' }],
    ['JWKS URI', { jwks_uri: 'http://idp.example/jwks' }],
  ])('fails before sending the code when the %s is plain http', async (_name, override) => {
    safeFetchMock.mockResolvedValueOnce(
      json({ ...IDP, issuer: 'https://idp.example', ...override })
    )

    const result = await runHandshake(baseInput)

    if (result.ok) throw new Error('expected failure')
    expect(result.stage).toBe('discovery-fetch')
    expect(result.hint).toMatch(/https/)
    // Only the discovery document was fetched: the code never left.
    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([baseInput.discoveryUrl])
  })

  it('refuses a plain-http discovery URL without fetching it', async () => {
    const result = await runHandshake({
      ...baseInput,
      discoveryUrl: 'http://idp.example/.well-known/openid-configuration',
    })

    if (result.ok) throw new Error('expected failure')
    expect(result.stage).toBe('discovery-fetch')
    expect(result.hint).toMatch(/https/)
    expect(safeFetchMock).not.toHaveBeenCalled()
  })

  it('fails a manual-endpoint provider whose stored token endpoint is plain http', async () => {
    const result = await runHandshake({
      ...baseInput,
      discoveryUrl: undefined,
      tokenEndpoint: 'http://idp.example/token',
      jwksUri: IDP.jwks_uri,
      issuer: 'https://idp.example',
    })

    if (result.ok) throw new Error('expected failure')
    expect(result.stage).toBe('discovery-fetch')
    expect(safeFetchMock).not.toHaveBeenCalled()
  })

  it('fails when the discovered authorization endpoint is plain http or private', async () => {
    safeFetchMock.mockResolvedValueOnce(
      json({
        ...IDP,
        issuer: 'https://idp.example',
        authorization_endpoint: 'http://idp.example/authorize',
      })
    )
    const plainHttp = await runHandshake(baseInput)

    safeFetchMock.mockResolvedValueOnce(json({ ...IDP, issuer: 'https://idp.example' }))
    checkUrlSafetyMock.mockResolvedValueOnce({ safe: false, reason: 'ssrf-rejected' })
    const privateAddress = await runHandshake(baseInput)

    for (const result of [plainHttp, privateAddress]) {
      if (result.ok) throw new Error('expected failure')
      expect(result.stage).toBe('discovery-fetch')
      expect(result.hint).toMatch(/authorization_endpoint/)
    }
    expect(checkUrlSafetyMock).toHaveBeenCalledTimes(1)
    expect(checkUrlSafetyMock).toHaveBeenCalledWith(IDP.authorization_endpoint)
    // Neither run went past discovery.
    expect(safeFetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips a plain-http userinfo endpoint instead of sending the access token to it', async () => {
    idpResponds(
      { issuer: 'https://idp.example', userinfo_endpoint: 'http://idp.example/userinfo' },
      await signedIdToken({ iss: 'https://idp.example' })
    )

    const result = await runHandshake(baseInput)

    if (!result.ok) throw new Error(`expected success, got ${result.stage}: ${result.hint}`)
    expect(result.steps).toContainEqual(expect.objectContaining({ ok: false, stage: 'userinfo' }))
    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([
      baseInput.discoveryUrl,
      IDP.token_endpoint,
      IDP.jwks_uri,
    ])
  })
})

// JSON that parses but is not an object must fail its stage, not throw out of
// the handshake: the callback route has no handler around it, and the test
// session is already consumed, so the admin would never see a result.
describe('runHandshake non-object JSON bodies', () => {
  it.each([['null'], ['[]'], ['"text"']])('fails discovery on a %s document', async (body) => {
    safeFetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }))

    const result = await runHandshake(baseInput)

    if (result.ok) throw new Error('expected failure')
    expect(result.stage).toBe('discovery-fetch')
    expect(result.hint).toMatch(/not an object/)
  })

  it('fails the token exchange on a null error body', async () => {
    safeFetchMock
      .mockResolvedValueOnce(json({ ...IDP, issuer: 'https://idp.example' }))
      .mockResolvedValueOnce(new Response('null', { status: 400 }))

    const result = await runHandshake(baseInput)

    if (result.ok) throw new Error('expected failure')
    expect(result.stage).toBe('token-exchange')
    expect(result.errorCode).toBeUndefined()
  })

  it('fails the token exchange on a null token response', async () => {
    safeFetchMock
      .mockResolvedValueOnce(json({ ...IDP, issuer: 'https://idp.example' }))
      .mockResolvedValueOnce(new Response('null', { status: 200 }))

    const result = await runHandshake(baseInput)

    if (result.ok) throw new Error('expected failure')
    expect(result.stage).toBe('token-exchange')
    expect(result.hint).toMatch(/not an object/)
  })
})
