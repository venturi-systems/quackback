/**
 * Pure OIDC handshake driver for the admin "Test sign-in" feature.
 *
 * Imports NOTHING from db/session/user/account tables. The handshake
 * is purely an outbound-fetch + token-decode + claim-check pipeline.
 * Statically guarantees a test run cannot create a session or mutate
 * user state.
 *
 * Each stage returns a structured result so the UI can render per-stage
 * status. On failure, includes an error code AND a human-readable hint
 * sourced from `oidc-error-explain.ts`.
 */

import { jwtVerify, createLocalJWKSet, decodeProtectedHeader, decodeJwt } from 'jose'
import { acceptedIssuers, asHttpsUrl } from './custom-oidc-fetch'
import { explainAuthorizeError, explainTokenError } from './oidc-error-explain'

export type HandshakeStage =
  | 'state-validation'
  | 'idp-authorize'
  | 'discovery-fetch'
  | 'token-exchange'
  | 'id-token-decode'
  | 'signature-verify'
  | 'claim-check'
  | 'userinfo'

export interface HandshakeInput {
  state: string | null
  code: string | null
  expectedState: string
  expectedNonce: string
  /** Present for discovery providers (endpoints fetched from the doc). Absent
   *  for manual-endpoint providers, which pass the resolved endpoints below. */
  discoveryUrl?: string
  /** Pre-resolved endpoints for manual-endpoint providers (no discovery doc). */
  tokenEndpoint?: string
  jwksUri?: string
  issuer?: string
  userinfoEndpoint?: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** PKCE verifier minted at authorize time (S256 challenge). */
  codeVerifier: string
  /** IdP-returned `error` query parameter, if the authorize step failed. */
  idpError?: string | null
  idpErrorDescription?: string | null
}

export interface DiagnosticStep {
  ok: boolean
  stage: HandshakeStage
  label: string
  detail?: string
}

export type HandshakeResult =
  | {
      ok: true
      steps: DiagnosticStep[]
      claims: {
        iss: string
        sub: string
        aud: string | string[]
        email?: string
        email_verified?: boolean
        name?: string
        preferred_username?: string
      }
      tokenInfo: {
        idTokenAlg: string
        hasAccessToken: boolean
        hasRefreshToken: boolean
        expiresIn?: number
      }
    }
  | {
      ok: false
      stage: HandshakeStage
      errorCode?: string
      hint: string
      raw?: unknown
      steps: DiagnosticStep[]
    }

/** A parsed JSON value that is a plain object, not null, an array or a scalar. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An untrusted endpoint or claim value, printable in a hint. */
function shown(value: unknown): string {
  return typeof value === 'string' && value ? value : 'missing'
}

export async function runHandshake(input: HandshakeInput): Promise<HandshakeResult> {
  const steps: DiagnosticStep[] = []

  if (input.idpError) {
    return {
      ok: false,
      stage: 'idp-authorize',
      errorCode: input.idpError,
      hint: explainAuthorizeError(input.idpError, input.idpErrorDescription),
      steps,
    }
  }

  if (!input.state || !input.code) {
    return {
      ok: false,
      stage: 'state-validation',
      hint: 'The IdP redirect did not include a state or code parameter. Check that your authorization-code grant is enabled on the IdP application.',
      steps,
    }
  }
  if (input.state !== input.expectedState) {
    return {
      ok: false,
      stage: 'state-validation',
      hint: 'State mismatch. Possible CSRF, replay, or expired test session. Start the test again.',
      steps,
    }
  }
  steps.push({ ok: true, stage: 'state-validation', label: 'State validated' })

  // Every sub-endpoint we fetch below (token_endpoint, jwks_uri,
  // userinfo_endpoint) is pinned by its own SSRF-safe safeFetch call (validate,
  // connect to the validated IP, never follow redirects), so a hostile
  // discovery doc or manual endpoint can't point us at the internal network.
  const { safeFetch, SsrfError, checkUrlSafety } = await import(
    '@/lib/server/content/ssrf-guard'
  )

  // Resolve the IdP's issuer + endpoints: fetch the discovery doc for discovery
  // providers, or use the manually-configured endpoints for installs with no
  // discovery document. The rest of the handshake is identical either way.
  let discovery: {
    issuer: string
    authorization_endpoint?: string
    token_endpoint: string
    jwks_uri: string
    userinfo_endpoint?: string
  }
  if (input.discoveryUrl) {
    // Sign-in never fetches a plain-http discovery URL: a document read in
    // clear could name any token endpoint (`fetchDiscovery`).
    if (!asHttpsUrl(input.discoveryUrl)) {
      return {
        ok: false,
        stage: 'discovery-fetch',
        hint: `Discovery URL (${input.discoveryUrl}) must be an https:// URL. Sign-in refuses any other.`,
        steps,
      }
    }
    let discoveryRes: Response
    try {
      discoveryRes = await safeFetch(input.discoveryUrl, { timeoutMs: 5000 })
    } catch (err) {
      if (err instanceof SsrfError) {
        return {
          ok: false,
          stage: 'discovery-fetch',
          hint: `Discovery URL (${input.discoveryUrl}) is not safe to fetch (${err.reason}). Use a public IdP URL.`,
          steps,
        }
      }
      return {
        ok: false,
        stage: 'discovery-fetch',
        hint: `Discovery URL could not be reached: ${err instanceof Error ? err.message : 'network error'}. Check the URL, your DNS/firewall, and IdP availability.`,
        steps,
      }
    }
    if (!discoveryRes.ok) {
      return {
        ok: false,
        stage: 'discovery-fetch',
        hint: `Discovery URL returned ${discoveryRes.status}. Check the URL and IdP availability.`,
        steps,
      }
    }
    let discoveryJson: unknown
    try {
      discoveryJson = await discoveryRes.json()
    } catch (err) {
      return {
        ok: false,
        stage: 'discovery-fetch',
        hint: `Discovery URL returned non-JSON response: ${err instanceof Error ? err.message : 'parse error'}. Check that the URL points at a valid OIDC discovery document.`,
        steps,
      }
    }
    // `null`, an array or a scalar is valid JSON but not a document; reading
    // its fields below would throw outside any handler.
    if (!isJsonObject(discoveryJson)) {
      return {
        ok: false,
        stage: 'discovery-fetch',
        hint: 'Discovery URL returned JSON that is not an object. Check that the URL points at a valid OIDC discovery document.',
        steps,
      }
    }
    discovery = discoveryJson as typeof discovery
    steps.push({ ok: true, stage: 'discovery-fetch', label: 'Discovery doc fetched' })
  } else if (input.tokenEndpoint && input.jwksUri && input.issuer) {
    discovery = {
      issuer: input.issuer,
      token_endpoint: input.tokenEndpoint,
      jwks_uri: input.jwksUri,
      userinfo_endpoint: input.userinfoEndpoint,
    }
    steps.push({ ok: true, stage: 'discovery-fetch', label: 'Using configured endpoints' })
  } else {
    return {
      ok: false,
      stage: 'discovery-fetch',
      hint: 'Provider has no discovery URL and is missing one or more manual endpoints (token, JWKS, issuer).',
      steps,
    }
  }

  // Hold the endpoints to the https rule production sign-in applies
  // (`asHttpsUrl` in custom-oidc-fetch.ts), so the test never passes a
  // configuration sign-in would refuse. The token endpoint receives the code
  // and client secret, and sign-in refuses a plain-http one. Sign-in never
  // reads the JWKS, but here it decides which signing keys the test trusts,
  // so it must be https too. A plain-http userinfo endpoint is skipped below,
  // as sign-in drops it rather than send the access token.
  const tokenEndpoint = asHttpsUrl(discovery.token_endpoint)
  const jwksUri = asHttpsUrl(discovery.jwks_uri)
  if (!tokenEndpoint || !jwksUri) {
    return {
      ok: false,
      stage: 'discovery-fetch',
      hint: `The token endpoint (${shown(discovery.token_endpoint)}) and JWKS URI (${shown(discovery.jwks_uri)}) must both be https:// URLs. Sign-in refuses a plain-http token endpoint, and the test only trusts signing keys fetched over https.`,
      steps,
    }
  }
  const userinfoEndpoint = asHttpsUrl(discovery.userinfo_endpoint)
  if (input.discoveryUrl) {
    // Sign-in sends the browser to the discovered authorization endpoint only
    // when it is https and resolves to a public address (`fetchDiscovery` in
    // custom-oidc-fetch.ts). A test that skipped the check could pass for a
    // provider every real sign-in refuses.
    const authorizationEndpoint = asHttpsUrl(discovery.authorization_endpoint)
    const verdict = authorizationEndpoint
      ? await checkUrlSafety(authorizationEndpoint)
      : undefined
    if (!verdict?.safe) {
      return {
        ok: false,
        stage: 'discovery-fetch',
        hint: `The discovery document's authorization_endpoint (${shown(discovery.authorization_endpoint)}) must be an https:// URL on a public address. Sign-in refuses it otherwise.`,
        steps,
      }
    }
  }

  // Mirror production: Better-Auth's genericOAuth plugin runs with
  // pkce: true in our config, so the test flow sends code_verifier
  // too. Diverging here would test a slightly-different protocol and
  // produce false positives.
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code_verifier: input.codeVerifier,
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  })
  let tokenRes: Response
  try {
    tokenRes = await safeFetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: tokenBody.toString(),
      timeoutMs: 10_000,
    })
  } catch (err) {
    if (err instanceof SsrfError) {
      return {
        ok: false,
        stage: 'token-exchange',
        hint: `The IdP's token endpoint (${tokenEndpoint}) is not safe to fetch (${err.reason}). The discovery document may be misconfigured or hostile.`,
        steps,
      }
    }
    return {
      ok: false,
      stage: 'token-exchange',
      hint: `Token endpoint could not be reached: ${err instanceof Error ? err.message : 'network error'}.`,
      steps,
    }
  }
  if (!tokenRes.ok) {
    // A body of `null` parses; reading `.error` off it would throw.
    const parsedError: unknown = await tokenRes.json().catch(() => ({}))
    const errBody = (isJsonObject(parsedError) ? parsedError : {}) as {
      error?: string
      error_description?: string
    }
    return {
      ok: false,
      stage: 'token-exchange',
      errorCode: errBody.error,
      hint: explainTokenError(errBody.error, errBody.error_description, tokenRes.status),
      raw: errBody,
      steps,
    }
  }
  let tokenJson: unknown
  try {
    tokenJson = await tokenRes.json()
  } catch (err) {
    return {
      ok: false,
      stage: 'token-exchange',
      hint: `Token endpoint returned non-JSON success response: ${err instanceof Error ? err.message : 'parse error'}. The IdP responded 2xx but the body could not be parsed as JSON.`,
      steps,
    }
  }
  if (!isJsonObject(tokenJson)) {
    return {
      ok: false,
      stage: 'token-exchange',
      hint: 'Token endpoint returned JSON that is not an object. The IdP responded 2xx without a token response.',
      steps,
    }
  }
  const tokens = tokenJson as {
    id_token?: string
    access_token?: string
    refresh_token?: string
    expires_in?: number
    token_type?: string
  }
  if (!tokens.id_token) {
    return {
      ok: false,
      stage: 'token-exchange',
      hint: "No id_token returned. Make sure 'openid' is in the requested scopes and your IdP is configured to issue ID tokens for authorization-code grants.",
      steps,
    }
  }
  steps.push({ ok: true, stage: 'token-exchange', label: 'Token exchange succeeded' })

  let header: ReturnType<typeof decodeProtectedHeader>
  try {
    header = decodeProtectedHeader(tokens.id_token)
  } catch (err) {
    return {
      ok: false,
      stage: 'id-token-decode',
      hint: `ID token is not a well-formed JWT (cannot decode header): ${err instanceof Error ? err.message : 'decode error'}. The IdP returned an id_token that is not a valid compact JWS.`,
      steps,
    }
  }
  steps.push({
    ok: true,
    stage: 'id-token-decode',
    label: 'ID token decoded',
    detail: `alg=${header.alg ?? '?'} kid=${header.kid ?? '?'}`,
  })

  let verifiedPayload: ReturnType<typeof decodeJwt>
  try {
    // Fetch the JWKS through the pinned fetch rather than letting jose's
    // createRemoteJWKSet do its own unpinned (DNS-rebind-able) fetch,
    // then verify against the resulting local key set.
    const jwksRes = await safeFetch(jwksUri, {
      timeoutMs: 5000,
      maxResponseBytes: 256 * 1024,
    })
    if (!jwksRes.ok) {
      return {
        ok: false,
        stage: 'signature-verify',
        hint: `JWKS endpoint returned ${jwksRes.status}. The IdP's jwks_uri must serve the signing key set.`,
        steps,
      }
    }
    const jwks = createLocalJWKSet(
      (await jwksRes.json()) as Parameters<typeof createLocalJWKSet>[0]
    )
    // No `issuer` option: jose would demand an exact match, which fails the
    // issuer forms production accepts. `iss` is checked just below instead.
    const { payload } = await jwtVerify(tokens.id_token, jwks, { audience: input.clientId })
    verifiedPayload = payload
  } catch (err) {
    if (err instanceof SsrfError) {
      return {
        ok: false,
        stage: 'signature-verify',
        hint: `The IdP's JWKS URI (${jwksUri}) is not safe to fetch (${err.reason}). The discovery document may be misconfigured or hostile.`,
        steps,
      }
    }
    return {
      ok: false,
      stage: 'signature-verify',
      hint: `ID token signature verification failed: ${err instanceof Error ? err.message : 'unknown error'}. Likely causes: JWKS rotation, or 'aud' claim does not include your client_id.`,
      steps,
    }
  }
  steps.push({ ok: true, stage: 'signature-verify', label: 'Signature verified against JWKS' })

  // The issuer rule production sign-in applies (`acceptedIssuers`): an Entra
  // multi-tenant `{tenantid}` template is filled from the token's `tid`, and
  // Google's bare `accounts.google.com` form is accepted. As in production, the
  // check runs whenever an issuer is known.
  const expectedIssuer =
    typeof discovery.issuer === 'string' && discovery.issuer ? discovery.issuer : undefined
  if (expectedIssuer) {
    const iss = verifiedPayload.iss
    const accepted = acceptedIssuers(expectedIssuer, verifiedPayload)
    if (typeof iss !== 'string' || !accepted.includes(iss)) {
      return {
        ok: false,
        stage: 'claim-check',
        hint: `ID token issuer (${shown(iss)}) does not match the IdP issuer (${expectedIssuer}). Check that the discovery URL or configured issuer belongs to the IdP that issued the token.`,
        steps,
      }
    }
    steps.push({ ok: true, stage: 'claim-check', label: 'Issuer matched', detail: iss })
  }

  if (verifiedPayload.nonce !== input.expectedNonce) {
    return {
      ok: false,
      stage: 'claim-check',
      hint: 'Nonce mismatch in ID token. Possible replay attack or IdP not honoring nonce.',
      steps,
    }
  }
  steps.push({ ok: true, stage: 'claim-check', label: 'Nonce matched' })

  if (!verifiedPayload.sub) {
    return {
      ok: false,
      stage: 'claim-check',
      hint: "ID token missing required 'sub' claim. The IdP must include a stable subject identifier on every ID token (OIDC core requirement).",
      steps,
    }
  }

  if (!verifiedPayload.email) {
    return {
      ok: false,
      stage: 'claim-check',
      hint: "ID token has no 'email' claim. Quackback requires an email to create users. Configure your IdP's claim mapper to release the email claim (Keycloak: client scopes; Okta: claim mappers; Entra: API permissions + admin consent).",
      steps,
    }
  }
  steps.push({
    ok: true,
    stage: 'claim-check',
    label: 'Email claim present',
    detail: typeof verifiedPayload.email === 'string' ? verifiedPayload.email : undefined,
  })

  if (discovery.userinfo_endpoint && tokens.access_token && !userinfoEndpoint) {
    steps.push({
      ok: false,
      stage: 'userinfo',
      label: 'Userinfo endpoint is not https, so sign-in will not use it',
    })
  } else if (userinfoEndpoint && tokens.access_token) {
    try {
      const uiRes = await safeFetch(userinfoEndpoint, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        timeoutMs: 5000,
      })
      steps.push({
        ok: uiRes.ok,
        stage: 'userinfo',
        label: uiRes.ok ? 'Userinfo endpoint reachable' : `Userinfo failed (${uiRes.status})`,
      })
    } catch {
      steps.push({ ok: false, stage: 'userinfo', label: 'Userinfo unreachable or unsafe to fetch' })
    }
  }

  return {
    ok: true,
    steps,
    claims: {
      iss: verifiedPayload.iss as string,
      sub: verifiedPayload.sub as string,
      aud: verifiedPayload.aud as string | string[],
      email: verifiedPayload.email as string,
      email_verified: verifiedPayload.email_verified as boolean | undefined,
      name: verifiedPayload.name as string | undefined,
      preferred_username: verifiedPayload.preferred_username as string | undefined,
    },
    tokenInfo: {
      idTokenAlg: (header.alg ?? 'unknown') as string,
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    },
  }
}
