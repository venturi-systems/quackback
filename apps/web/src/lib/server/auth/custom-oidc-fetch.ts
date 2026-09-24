/**
 * SSRF-pinned runtime fetches for custom OIDC providers.
 *
 * Custom OIDC providers are admin-supplied. Their discovery and issuer URLs are
 * SSRF-checked when saved, but Better-Auth's genericOAuth plugin fetches at
 * sign-in time with its own unpinned client: the discovery document, then the
 * token and userinfo endpoints the document names, then the token endpoint
 * again on refresh. That leaves a DNS-rebinding window between save and fetch,
 * and leaves every endpoint inside the discovery document unvalidated.
 *
 * This module is the production twin of the SSO test handshake
 * (`sso-test-handshake.ts`). Every runtime fetch goes through `safeFetch`,
 * which validates the host, connects to the validated IP and never follows a
 * redirect. The plugin is handed explicit endpoints and never a
 * `discoveryUrl`, so it has nothing of its own to fetch. Anything that cannot
 * be fetched this way fails closed.
 *
 * The SSRF guard and Better-Auth's OAuth helpers are imported lazily, as in
 * the handshake: `build-oauth-configs.ts` imports this module and is itself
 * imported by a server-function module.
 */

import { decodeJwt } from 'jose'
import type { OAuth2Tokens, OAuth2UserInfo } from 'better-auth/oauth2'
import type { SafeFetchInit } from '@/lib/server/content/ssrf-guard'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'custom-oidc-fetch' })

/** The endpoints a custom OIDC provider signs in against. */
export interface OidcEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  userinfoEndpoint?: string
  issuer?: string
}

/**
 * How long a fetched discovery document is trusted before the next request
 * re-fetches it. Before this module the plugin re-fetched it on every request.
 */
export const DISCOVERY_TTL_MS = 10 * 60 * 1000

const DISCOVERY_TIMEOUT_MS = 5_000
const TOKEN_TIMEOUT_MS = 10_000
const USERINFO_TIMEOUT_MS = 5_000
// A partial body is never acted on: an over-cap response is an error.
const MAX_RESPONSE_BYTES = 256 * 1024

/** A custom-OIDC fetch that returned an unusable response. */
export class OidcFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcFetchError'
  }
}

async function pinnedFetch(url: string, init: SafeFetchInit): Promise<Response> {
  const { safeFetch } = await import('@/lib/server/content/ssrf-guard')
  return safeFetch(url, { maxResponseBytes: MAX_RESPONSE_BYTES, onOverflow: 'error', ...init })
}

/** The value as an absolute http(s) URL string, or undefined. */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:' ? value : undefined
  } catch {
    return undefined
  }
}

async function readJsonObject(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) {
    let code = ''
    try {
      const body: unknown = await res.json()
      const error = (body as { error?: unknown } | null)?.error
      if (typeof error === 'string') code = ` (${error})`
    } catch {
      // Error bodies are not always JSON; the status alone is enough.
    }
    throw new OidcFetchError(`${what} returned HTTP ${res.status}${code}`)
  }
  const data: unknown = await res.json()
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new OidcFetchError(`${what} did not return a JSON object`)
  }
  return data as Record<string, unknown>
}

/**
 * A form POST with an explicit Content-Length, as the plugin's fetch sent it.
 * `URLSearchParams` percent-encodes every non-ASCII byte, so the string length
 * is the byte length.
 */
function formRequest(
  body: URLSearchParams,
  headers: Record<string, unknown>
): Pick<SafeFetchInit, 'method' | 'headers' | 'body'> {
  const encoded = body.toString()
  const stringHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) stringHeaders[key] = String(value)
  stringHeaders['content-length'] = String(encoded.length)
  return { method: 'POST', headers: stringHeaders, body: encoded }
}

/** `expires_in`-style seconds as an absolute date, or undefined. */
function secondsFromNow(value: unknown): Date | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1000) : undefined
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

type DiscoveryCacheEntry = { endpoints: OidcEndpoints; fetchedAt: number }
const discoveryCache = new Map<string, DiscoveryCacheEntry>()
const discoveryInflight = new Map<string, Promise<OidcEndpoints>>()

/** Forget every cached discovery document. For tests. */
export function clearOidcDiscoveryCache(): void {
  discoveryCache.clear()
  discoveryInflight.clear()
}

async function fetchDiscovery(discoveryUrl: string): Promise<OidcEndpoints> {
  const res = await pinnedFetch(discoveryUrl, { timeoutMs: DISCOVERY_TIMEOUT_MS })
  const doc = await readJsonObject(res, 'discovery document')
  const authorizationEndpoint = httpUrl(doc.authorization_endpoint)
  const tokenEndpoint = httpUrl(doc.token_endpoint)
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new OidcFetchError(
      'discovery document is missing an http(s) authorization_endpoint or token_endpoint'
    )
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    userinfoEndpoint: httpUrl(doc.userinfo_endpoint),
    issuer: typeof doc.issuer === 'string' && doc.issuer ? doc.issuer : undefined,
  }
}

/**
 * The endpoints from a discovery document fetched within the TTL, or
 * undefined. Never fetches: this is what the plugin's synchronous config reads
 * see, so an expired or failed document reads as "not configured".
 */
export function peekOidcDiscovery(discoveryUrl: string): OidcEndpoints | undefined {
  const entry = discoveryCache.get(discoveryUrl)
  if (!entry || Date.now() - entry.fetchedAt >= DISCOVERY_TTL_MS) return undefined
  return entry.endpoints
}

/**
 * The endpoints from the discovery document, fetched through `safeFetch` when
 * the cached copy is missing or expired. Concurrent callers share one fetch. A
 * failure is not cached and rejects, so the caller fails closed and the next
 * request tries again.
 */
export function resolveOidcDiscovery(discoveryUrl: string): Promise<OidcEndpoints> {
  const cached = peekOidcDiscovery(discoveryUrl)
  if (cached) return Promise.resolve(cached)
  const existing = discoveryInflight.get(discoveryUrl)
  if (existing) return existing
  const inflight: Promise<OidcEndpoints> = fetchDiscovery(discoveryUrl)
    .then((endpoints) => {
      discoveryCache.set(discoveryUrl, { endpoints, fetchedAt: Date.now() })
      return endpoints
    })
    .finally(() => {
      if (discoveryInflight.get(discoveryUrl) === inflight) discoveryInflight.delete(discoveryUrl)
    })
  discoveryInflight.set(discoveryUrl, inflight)
  return inflight
}

/** Where a provider's endpoints come from. */
export interface OidcEndpointSource {
  /** Endpoints the plugin may use right now, or undefined (fails closed). */
  peek(): OidcEndpoints | undefined
  /** Endpoints for a fetch about to happen. Rejects when none resolve. */
  resolve(): Promise<OidcEndpoints>
}

/**
 * Discovery providers resolve their endpoints through `resolveOidcDiscovery`.
 * Manual-endpoint providers use the stored URLs. A provider row that carries
 * both keeps the plugin's old precedence: the discovery document wins, and the
 * stored URLs are the fallback when it cannot be fetched.
 */
export function createOidcEndpointSource(provider: {
  discoveryUrl?: string
  authorizationUrl?: string
  tokenUrl?: string
}): OidcEndpointSource {
  const manual: OidcEndpoints | undefined =
    provider.authorizationUrl && provider.tokenUrl
      ? { authorizationEndpoint: provider.authorizationUrl, tokenEndpoint: provider.tokenUrl }
      : undefined
  const { discoveryUrl } = provider
  if (!discoveryUrl) {
    return {
      peek: () => manual,
      resolve: async () => {
        if (!manual) throw new OidcFetchError('provider has no discovery URL or manual endpoints')
        return manual
      },
    }
  }
  return {
    peek: () => peekOidcDiscovery(discoveryUrl) ?? manual,
    resolve: async () => {
      try {
        return await resolveOidcDiscovery(discoveryUrl)
      } catch (err) {
        if (manual) return manual
        throw err
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Token exchange, refresh and userinfo
// ---------------------------------------------------------------------------

export interface PinnedOidcClient {
  clientId: string
  clientSecret: string
  endpoints: OidcEndpointSource
}

/**
 * The genericOAuth `getToken` hook: the authorization-code exchange, sent to
 * the token endpoint through `safeFetch`. The request body is built by
 * Better-Auth's own helper, so the wire format matches the unpinned exchange
 * it replaces.
 */
export function createPinnedTokenExchange(client: PinnedOidcClient) {
  return async (data: {
    code: string
    redirectURI: string
    codeVerifier?: string
    deviceId?: string
  }): Promise<OAuth2Tokens> => {
    const { tokenEndpoint } = await client.endpoints.resolve()
    const { authorizationCodeRequest, getOAuth2Tokens } = await import('better-auth/oauth2')
    const { body, headers } = await authorizationCodeRequest({
      code: data.code,
      codeVerifier: data.codeVerifier,
      deviceId: data.deviceId,
      redirectURI: data.redirectURI,
      options: { clientId: client.clientId, clientSecret: client.clientSecret },
    })
    const res = await pinnedFetch(tokenEndpoint, {
      ...formRequest(body, headers),
      timeoutMs: TOKEN_TIMEOUT_MS,
    })
    return getOAuth2Tokens(await readJsonObject(res, 'token endpoint'))
  }
}

/**
 * Pinned replacement for the plugin's `refreshAccessToken`, which has no
 * config hook of its own (see `custom-oidc-plugin.ts`). Returns the same token
 * shape as the plugin's refresh.
 */
export function createPinnedTokenRefresh(client: PinnedOidcClient) {
  return async (refreshToken: string): Promise<OAuth2Tokens> => {
    const { tokenEndpoint } = await client.endpoints.resolve()
    const { refreshAccessTokenRequest } = await import('better-auth/oauth2')
    const { body, headers } = await refreshAccessTokenRequest({
      refreshToken,
      options: { clientId: client.clientId, clientSecret: client.clientSecret },
    })
    const res = await pinnedFetch(tokenEndpoint, {
      ...formRequest(body, headers),
      timeoutMs: TOKEN_TIMEOUT_MS,
    })
    const data = await readJsonObject(res, 'token endpoint')
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
    const tokens: OAuth2Tokens = {
      accessToken: text(data.access_token),
      refreshToken: text(data.refresh_token),
      tokenType: text(data.token_type),
      scopes: typeof data.scope === 'string' ? data.scope.split(' ') : undefined,
      idToken: text(data.id_token),
    }
    const accessTokenExpiresAt = secondsFromNow(data.expires_in)
    if (accessTokenExpiresAt) tokens.accessTokenExpiresAt = accessTokenExpiresAt
    const refreshTokenExpiresAt = secondsFromNow(data.refresh_token_expires_in)
    if (refreshTokenExpiresAt) tokens.refreshTokenExpiresAt = refreshTokenExpiresAt
    return tokens
  }
}

function isNonEmptyId(id: unknown): id is string | number {
  return id !== undefined && id !== null && id !== ''
}

/**
 * The genericOAuth `getUserInfo` hook. Mirrors the plugin's default: claims
 * from the ID token when it carries `sub` and `email`, otherwise the userinfo
 * endpoint from the discovery document, fetched through `safeFetch`. Any fetch
 * failure returns null, which the plugin turns into a failed sign-in.
 *
 * The ID token is decoded without a signature check, exactly as the plugin
 * does: it arrived from the token endpoint over the pinned TLS back channel
 * (OIDC Core 3.1.3.7).
 */
export function createPinnedUserInfo(client: Pick<PinnedOidcClient, 'endpoints'>) {
  return async (tokens: OAuth2Tokens): Promise<OAuth2UserInfo | null> => {
    if (tokens.idToken) {
      const claims = decodeJwt(tokens.idToken)
      if (claims.sub && claims.email) {
        const fromIdToken: Record<string, unknown> = {
          id: claims.sub,
          emailVerified: claims.email_verified,
          image: claims.picture,
          ...claims,
        }
        return fromIdToken as OAuth2UserInfo
      }
    }

    let userinfoEndpoint: string | undefined
    try {
      userinfoEndpoint = (await client.endpoints.resolve()).userinfoEndpoint
    } catch (err) {
      log.warn({ err }, 'custom OIDC endpoints unavailable for userinfo')
      return null
    }
    if (!userinfoEndpoint) return null

    let profile: Record<string, unknown>
    try {
      const res = await pinnedFetch(userinfoEndpoint, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
        timeoutMs: USERINFO_TIMEOUT_MS,
      })
      profile = await readJsonObject(res, 'userinfo endpoint')
    } catch (err) {
      log.warn({ err }, 'custom OIDC userinfo fetch failed')
      return null
    }

    const { id: profileId, ...profileFields } = profile
    const subjectId = isNonEmptyId(profileId)
      ? profileId
      : isNonEmptyId(profile.sub)
        ? profile.sub
        : undefined
    const fromUserinfo: Record<string, unknown> = {
      ...profileFields,
      ...(subjectId !== undefined ? { id: subjectId } : {}),
      email: profile.email,
      emailVerified: profile.email_verified ?? false,
      image: profile.picture,
      name: profile.name,
    }
    return fromUserinfo as OAuth2UserInfo
  }
}
