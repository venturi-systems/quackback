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

import { decodeJwt, type JWTPayload } from 'jose'
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
/**
 * Hard ceiling on one discovery resolution: the discovery fetch plus the DNS
 * check of the authorization endpoint. Concurrent sign-ins share the in-flight
 * promise, so a promise that never settled would block every sign-in for that
 * provider; this deadline guarantees it settles.
 */
const DISCOVERY_DEADLINE_MS = 15_000
const TOKEN_TIMEOUT_MS = 10_000
const USERINFO_TIMEOUT_MS = 5_000
// A partial body is never acted on: an over-cap response is an error.
const MAX_RESPONSE_BYTES = 256 * 1024
/** Clock-skew allowance for the ID token `exp` check (OIDC Core 3.1.3.7). */
const ID_TOKEN_CLOCK_SKEW_S = 120

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

/**
 * The value as an absolute https URL string, or undefined. Every endpoint a
 * provider signs in against must be https (OIDC Discovery 1.0 §3, RFC 8414
 * §2): the token endpoint receives the code, the client secret and refresh
 * tokens, and the userinfo endpoint the access token. The rule covers the
 * discovery URL itself (a document fetched in clear could name any token
 * endpoint), the endpoints a discovery document names, a manual provider's
 * stored endpoints and the SSO test's (`sso-test.ts`, `sso-test-handshake.ts`).
 * Not the zod `httpsUrl` schema in `lib/shared/schemas/auth.ts`, which
 * validates the same rule on input.
 */
export function asHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    return new URL(value).protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

/** Reject when `promise` has not settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OidcFetchError(`${what} did not settle within ${ms} ms`)),
      ms
    )
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
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
 * Fetch `url` through `safeFetch` and return its JSON object body. Rejects on
 * anything `safeFetch` refuses, a non-2xx status or a body that is not a JSON
 * object.
 */
export async function fetchPinnedJson(
  url: string,
  init: SafeFetchInit,
  what: string
): Promise<Record<string, unknown>> {
  return readJsonObject(await pinnedFetch(url, init), what)
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
  if (!asHttpsUrl(discoveryUrl)) {
    throw new OidcFetchError('discovery URL is not an https URL')
  }
  const res = await pinnedFetch(discoveryUrl, { timeoutMs: DISCOVERY_TIMEOUT_MS })
  const doc = await readJsonObject(res, 'discovery document')
  const authorizationEndpoint = asHttpsUrl(doc.authorization_endpoint)
  const tokenEndpoint = asHttpsUrl(doc.token_endpoint)
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new OidcFetchError(
      'discovery document is missing an https authorization_endpoint or token_endpoint'
    )
  }
  // A non-https userinfo_endpoint is dropped rather than used: the access
  // token is never sent in clear. Sign-ins whose ID token carries the email
  // do not need it.
  const userinfoEndpoint = asHttpsUrl(doc.userinfo_endpoint)
  // The authorization endpoint is never fetched server-side, but it is where
  // the user's browser is sent. The save-time policy refuses a private or
  // loopback authorizationUrl for that reason; hold the discovered one to the
  // same rule.
  const { checkUrlSafety } = await import('@/lib/server/content/ssrf-guard')
  const verdict = await checkUrlSafety(authorizationEndpoint)
  if (!verdict.safe) {
    throw new OidcFetchError(
      `discovery document names an authorization_endpoint that is not a public URL (${verdict.reason})`
    )
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    userinfoEndpoint,
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
  const inflight: Promise<OidcEndpoints> = withDeadline(
    fetchDiscovery(discoveryUrl),
    DISCOVERY_DEADLINE_MS,
    'discovery'
  )
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
 * Manual-endpoint providers use the stored URLs, plus the stored userinfo URL
 * and expected issuer when the row has them (the same values the SSO test
 * handshake uses for a manual install). A provider row that carries both keeps
 * the plugin's old precedence: the discovery document wins, and the stored URLs
 * are the fallback when it cannot be fetched.
 *
 * Stored endpoints meet the https rule discovered ones do (`asHttpsUrl`): a
 * plain-http authorization or token URL leaves the provider with no manual
 * endpoints, and a plain-http userinfo URL is dropped. A plain-http discovery
 * URL is never fetched (`fetchDiscovery`), so it resolves like an unreachable
 * one. The save-time schema
 * already requires https, but a row can predate it: the startup backfill
 * (`backfill-custom-oidc-provider.ts`) copies legacy credential values as they
 * are, and a self-hosted GitLab issuer saved before the save-time https rule
 * (`auth-provider-credentials.ts`) can still be plain http.
 */
export function createOidcEndpointSource(provider: {
  discoveryUrl?: string
  authorizationUrl?: string
  tokenUrl?: string
  userInfoUrl?: string
  issuer?: string
}): OidcEndpointSource {
  const authorizationEndpoint = asHttpsUrl(provider.authorizationUrl)
  const tokenEndpoint = asHttpsUrl(provider.tokenUrl)
  const userinfoEndpoint = asHttpsUrl(provider.userInfoUrl)
  const manual: OidcEndpoints | undefined =
    authorizationEndpoint && tokenEndpoint
      ? {
          authorizationEndpoint,
          tokenEndpoint,
          ...(userinfoEndpoint ? { userinfoEndpoint } : {}),
          ...(provider.issuer ? { issuer: provider.issuer } : {}),
        }
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

/** Google documents both forms as valid `iss` values for its ID tokens. */
const GOOGLE_ISSUER = 'https://accounts.google.com'

/**
 * The `iss` values a given ID token may carry for a provider's issuer:
 * - Microsoft Entra's multi-tenant discovery documents (`common`,
 *   `organizations`) publish the issuer as a template,
 *   `https://login.microsoftonline.com/{tenantid}/v2.0`, and each token names
 *   its tenant in `tid`, so the template is filled in from that claim.
 * - Google's ID tokens carry `https://accounts.google.com` or the bare
 *   `accounts.google.com`, and Google says to accept either.
 * Any other issuer must match exactly. Production sign-in
 * (`idTokenClaimProblem`) and the SSO test handshake both check `iss` with
 * this, so a test passes exactly when sign-in would.
 */
export function acceptedIssuers(issuer: string, claims: JWTPayload): string[] {
  const tenant = claims.tid
  if (issuer.includes('{tenantid}') && typeof tenant === 'string' && tenant) {
    return [issuer.replace('{tenantid}', tenant)]
  }
  if (issuer === GOOGLE_ISSUER) return [GOOGLE_ISSUER, 'accounts.google.com']
  return [issuer]
}

/**
 * Why an ID token's claims must not be trusted, or undefined when they pass.
 *
 * The token is not signature-checked: it arrived from the token endpoint over
 * the pinned TLS back channel, which OIDC Core 3.1.3.7 step 6 accepts in place
 * of the signature. That substitution covers the signature only. The issuer
 * (step 2), audience (step 3) and expiry (step 9) checks are still required,
 * and are made here. The issuer is checked whenever one is known: from the
 * discovery document, or the expected issuer stored on a manual provider.
 */
export function idTokenClaimProblem(
  claims: JWTPayload,
  expected: { clientId: string; issuer?: string; nowMs?: number }
): string | undefined {
  if (
    expected.issuer &&
    (typeof claims.iss !== 'string' ||
      !acceptedIssuers(expected.issuer, claims).includes(claims.iss))
  ) {
    return 'iss does not match the issuer'
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(expected.clientId)) return 'aud does not contain the client id'
  if (typeof claims.exp !== 'number') return 'exp is missing'
  const nowS = (expected.nowMs ?? Date.now()) / 1000
  if (claims.exp + ID_TOKEN_CLOCK_SKEW_S <= nowS) return 'the ID token has expired'
  return undefined
}

/**
 * The genericOAuth `getUserInfo` hook. Mirrors the plugin's default: claims
 * from the ID token when it carries `sub` and `email`, otherwise the userinfo
 * endpoint, fetched through `safeFetch`. It returns null, which the plugin
 * turns into a failed sign-in, when:
 * - the ID token cannot be decoded or fails `idTokenClaimProblem`;
 * - the endpoints or the userinfo response cannot be fetched;
 * - the userinfo `sub` differs from the ID token's (OIDC Core 5.3.2).
 */
export function createPinnedUserInfo(client: Pick<PinnedOidcClient, 'clientId' | 'endpoints'>) {
  return async (tokens: OAuth2Tokens): Promise<OAuth2UserInfo | null> => {
    let endpoints: OidcEndpoints
    try {
      endpoints = await client.endpoints.resolve()
    } catch (err) {
      log.warn({ err }, 'custom OIDC endpoints unavailable for user info')
      return null
    }

    let idTokenSubject: unknown
    if (tokens.idToken) {
      let claims: JWTPayload
      try {
        claims = decodeJwt(tokens.idToken)
      } catch (err) {
        log.warn({ err }, 'custom OIDC ID token could not be decoded')
        return null
      }
      const problem = idTokenClaimProblem(claims, {
        clientId: client.clientId,
        issuer: endpoints.issuer,
      })
      if (problem) {
        log.warn({ problem }, 'custom OIDC ID token rejected')
        return null
      }
      if (claims.sub && claims.email) {
        const fromIdToken: Record<string, unknown> = {
          id: claims.sub,
          emailVerified: claims.email_verified,
          image: claims.picture,
          ...claims,
        }
        return fromIdToken as OAuth2UserInfo
      }
      idTokenSubject = claims.sub
    }

    const { userinfoEndpoint } = endpoints
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

    // OIDC Core 5.3.2: the userinfo `sub` must exactly match the ID token's,
    // or the response must not be used. A token substituted from another
    // user's session would otherwise sign in as that user.
    if (isNonEmptyId(idTokenSubject) && String(profile.sub) !== String(idTokenSubject)) {
      log.warn('custom OIDC userinfo sub does not match the ID token sub')
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
