// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { jwt } from 'better-auth/plugins'
import { oauthProvider } from '@better-auth/oauth-provider'
import { makeSignature } from 'better-auth/crypto'
import {
  ALLOW_UNAUTHENTICATED_CLIENT_REGISTRATION,
  OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES,
  OAUTH_CLIENT_REGISTRATION_DEFAULT_APPLICATION_TYPE,
} from '../oauth-client-defaults'

const ORIGIN = 'https://qb.example'
const RESOURCE = `${ORIGIN}/api/mcp`
const WIRE_TOKEN = 'initial-refresh-token'
const hash = (s: string) => createHash('sha256').update(s).digest('base64url')

afterEach(() => vi.useRealTimers())

function stack(reuseInterval = 60) {
  const now = new Date()
  const db: Record<string, Record<string, unknown>[]> = {
    user: [
      {
        id: 'user_ada',
        name: 'Ada',
        email: 'ada@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthConsent: [],
    oauthResource: [],
    oauthClientResource: [
      { id: 'client_resource', clientId: 'public-client', resourceId: RESOURCE },
    ],
    oauthClientAssertion: [],
    oauthAccessToken: [],
    oauthClient: [
      {
        id: 'client_row',
        clientId: 'public-client',
        tokenEndpointAuthMethod: 'none',
        applicationType: 'native',
        grantTypes: ['authorization_code', 'refresh_token'],
        scopes: ['read:feedback', 'offline_access'],
        redirectUris: ['https://client.example/callback'],
        disabled: false,
        createdAt: now,
      },
    ],
    oauthRefreshToken: [
      {
        id: 'refresh_initial',
        token: hash(WIRE_TOKEN),
        clientId: 'public-client',
        userId: 'user_ada',
        scopes: ['read:feedback', 'offline_access'],
        resources: [RESOURCE],
        revoked: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 30 * 24 * 3600_000),
      },
    ],
  }
  const auth = betterAuth({
    baseURL: ORIGIN,
    secret: 'native-refresh-regression-test-secret-0123456789abcdef',
    database: memoryAdapter(db),
    telemetry: { enabled: false },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: '/auth/login',
        consentPage: '/oauth/consent',
        scopes: [...OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES, 'write:feedback', 'offline_access'],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: ALLOW_UNAUTHENTICATED_CLIENT_REGISTRATION,
        clientRegistrationDefaultScopes: [...OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES],
        clientRegistrationDefaultResources: [RESOURCE],
        clientRegistrationDefaultApplicationType:
          OAUTH_CLIENT_REGISTRATION_DEFAULT_APPLICATION_TYPE,
        enforcePerClientResources: true,
        resources: [RESOURCE],
        refreshTokenReuseInterval: reuseInterval,
        silenceWarnings: { oauthAuthServerConfig: true },
      }),
    ],
  })
  const refresh = (overrides: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'public-client',
          refresh_token: WIRE_TOKEN,
          resource: RESOURCE,
          ...overrides,
        }),
      })
    )
  const revoke = (token: string) =>
    auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'public-client',
          token,
          token_type_hint: 'refresh_token',
        }),
      })
    )
  const register = async (metadata: Record<string, unknown>) => {
    const context = await auth.$context
    const session = await context.internalAdapter.createSession('user_ada')
    const signature = await makeSignature(session.token, context.secret)
    return auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          cookie: `${context.authCookies.sessionToken.name}=${session.token}.${signature}`,
        },
        body: JSON.stringify({
          client_name: 'MCP redirect regression',
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          ...metadata,
        }),
      })
    )
  }
  return { db, refresh, revoke, auth, register }
}

describe('published OAuth provider native rotation replay', () => {
  it.each([
    'http://127.0.0.1:41234/callback',
    'http://localhost:41234/callback',
    'http://[::1]:41234/callback',
    'com.example.mcp:/callback',
    'mcpclient://auth/callback',
  ])('preserves native MCP registration for %s when application_type is omitted', async (uri) => {
    const { register } = stack()
    const response = await register({ redirect_uris: [uri] })
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201)
    expect((await response.json()).application_type).toBe('native')
  })

  it.each([
    { redirect_uris: ['http://remote.example/callback'] },
    { redirect_uris: ['http://127.0.0.1:41234/callback', 'http://remote.example/callback'] },
    { redirect_uris: ['http://127.0.0.1:41234/callback'], application_type: 'web' },
    { redirect_uris: ['http://localhost.evil.example/callback'] },
  ])(
    'refuses invalid redirects and preserves an explicit web classification: %j',
    async (metadata) => {
      const { db, register } = stack()
      const response = await register(metadata)
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('invalid_redirect_uri')
      expect(db.oauthClient).toHaveLength(1)
    }
  )

  it('gives authenticated dynamic clients only the configured read scopes and MCP resource', async () => {
    const { auth, db } = stack()
    const context = await auth.$context
    const session = await context.internalAdapter.createSession('user_ada')
    const signature = await makeSignature(session.token, context.secret)
    const cookie = `${context.authCookies.sessionToken.name}=${session.token}.${signature}`
    const register = (authenticated: boolean) =>
      auth.handler(
        new Request(`${ORIGIN}/api/auth/oauth2/register`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            ...(authenticated ? { cookie } : {}),
          },
          body: JSON.stringify({
            client_name: 'MCP regression client',
            redirect_uris: ['https://client.example/callback'],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
          }),
        })
      )
    expect((await register(false)).status).toBe(401)
    const registered = await register(true)
    expect(registered.status, JSON.stringify(await registered.clone().json())).toBe(201)
    const client = await registered.json()
    expect(client.scope.split(' ').sort()).toEqual(
      [...OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES].sort()
    )
    expect(client.scope).not.toContain('write:')
    const record = db.oauthClient.find((row) => row.clientId === client.client_id)!
    expect(record.clientCredentialsScopes).toEqual([])
    expect(
      db.oauthClientResource
        .filter((row) => row.clientId === client.client_id)
        .map((row) => row.resourceId)
    ).toEqual([RESOURCE])
  })

  it('replays an expired access token with zero remaining lifetime, without extending it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = Date.now()
    const { db, refresh } = stack(7 * 24 * 60 * 60)
    const first = await refresh()
    expect(first.status).toBe(200)
    const issued = await first.json()
    vi.setSystemTime(now + 3601_000)
    const replay = await refresh()
    expect(replay.status).toBe(200)
    const cached = await replay.json()
    expect(cached.access_token).toBe(issued.access_token)
    expect(cached.refresh_token).toBe(issued.refresh_token)
    expect(cached.expires_in).toBe(0)
    expect(db.oauthRefreshToken).toHaveLength(2)
    const successor = await refresh({ refresh_token: cached.refresh_token })
    expect(successor.status).toBe(200)
    const renewed = await successor.json()
    expect(renewed.access_token).not.toBe(issued.access_token)
    expect(renewed.expires_in).toBeGreaterThan(0)
  })

  it('cannot mint refresh authority after the successor is revoked through the real endpoint', async () => {
    const { db, refresh, revoke } = stack()
    const first = await refresh()
    expect(first.status).toBe(200)
    const issued = await first.json()
    const successor = db.oauthRefreshToken.find((row) => row.id !== 'refresh_initial')!
    const expiresAt = successor.expiresAt
    expect((await revoke(issued.refresh_token)).status).toBe(200)
    expect(successor.revoked).toBeTruthy()
    // Native overlap can replay an already-issued response; it never creates
    // a new token or extends the original token lifetime after revocation.
    const replay = await refresh()
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(issued)
    expect(db.oauthRefreshToken).toHaveLength(2)
    expect(successor.expiresAt).toEqual(expiresAt)
    const refused = await refresh({ refresh_token: issued.refresh_token })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toBe('invalid_grant')
    expect(db.oauthRefreshToken).toHaveLength(0)
  })

  it('refuses another client and replay beyond the native overlap interval', async () => {
    const { db, refresh } = stack()
    expect((await refresh()).status).toBe(200)
    expect((await refresh({ client_id: 'unknown-client' })).status).toBeGreaterThanOrEqual(400)
    expect(db.oauthRefreshToken).toHaveLength(2)
    db.oauthRefreshToken[0].rotationReplayExpiresAt = new Date(Date.now() - 1000)
    const expired = await refresh()
    expect(expired.status).toBe(400)
    expect((await expired.json()).error).toBe('invalid_grant')
    expect(db.oauthRefreshToken.every((row) => row.revoked)).toBe(true)
  })

  it('refreshes an active legacy grant with null resource fields after its client is linked', async () => {
    const { db, refresh } = stack()
    const old = db.oauthRefreshToken[0]
    old.resources = null
    old.requestedUserInfoClaims = null
    const response = await refresh()
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
    const result = await response.json()
    expect(result.scope.split(' ').sort()).toEqual(['offline_access', 'read:feedback'])
    const successor = db.oauthRefreshToken.find((row) => row.id !== 'refresh_initial')!
    expect(successor.resources).toEqual([RESOURCE])
    expect(old.revoked).toBeTruthy()
  })

  it('replays the same response without un-revoking or rotating a second time', async () => {
    const { db, refresh } = stack()
    const first = await refresh()
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200)
    const response = await first.json()
    const old = db.oauthRefreshToken.find((row) => row.id === 'refresh_initial')!
    expect(old.revoked).toBeTruthy()
    expect(old.rotatedAt).toBeTruthy()
    expect(old.rotationReplayResponse).toBeTruthy()
    const replay = await refresh()
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(response)
    expect(db.oauthRefreshToken).toHaveLength(2)
    expect(old.revoked).toBeTruthy()
  })

  it('refuses widened resources or scopes and legacy revocations without replay evidence', async () => {
    const { db, refresh } = stack()
    const first = await refresh()
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200)
    const widenings: Record<string, string>[] = [
      { scope: 'write:feedback' },
      { resource: 'https://other.example/api' },
    ]
    for (const overrides of widenings) {
      const rejected = await refresh(overrides)
      expect(rejected.status).toBe(400)
    }
    const old = db.oauthRefreshToken.find((row) => row.id === 'refresh_initial')!
    // Deliberate revocations/legacy rotations have no native replay marker.
    old.rotatedAt = null
    old.rotationReplayExpiresAt = null
    const rejected = await refresh()
    expect(rejected.status).toBe(400)
    expect((await rejected.json()).error).toBe('invalid_grant')
    expect(db.oauthRefreshToken.every((row) => row.revoked)).toBe(true)
  })
})
