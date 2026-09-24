/**
 * SSRF-pinned server-side fetches for a self-hosted GitLab.
 *
 * GitLab's optional `issuer` credential is an admin-supplied base URL.
 * Better-Auth's GitLab provider sends the code exchange and refresh to
 * `{issuer}/oauth/token` and the user lookup to `{issuer}/api/v4/user` with its
 * own unpinned fetch, carrying the client secret and the access token. The
 * issuer is SSRF-checked when it is saved (`url: true` in auth-providers.ts),
 * which still leaves a DNS-rebinding window between save and fetch: the same
 * gap `custom-oidc-fetch.ts` closes for custom OIDC.
 *
 * This plugin swaps those three methods on the registered GitLab provider for
 * ones that go through `safeFetch`, reusing the custom-OIDC token helpers so
 * the request bodies match Better-Auth's own. gitlab.com, used when no issuer
 * is set, is not admin-controlled and is left alone. The authorization URL is
 * a browser redirect and is not fetched server-side.
 *
 * The endpoints go through `createOidcEndpointSource`, so they meet the
 * custom-OIDC https rule: a plain-http issuer fails every pinned fetch closed
 * instead of sending the client secret or access token in clear.
 */

import type { OAuth2Tokens } from 'better-auth/oauth2'
import { logger } from '@/lib/server/logger'
import {
  createOidcEndpointSource,
  createPinnedTokenExchange,
  createPinnedTokenRefresh,
  fetchPinnedJson,
} from './custom-oidc-fetch'

const log = logger.child({ component: 'self-hosted-gitlab' })

const USERINFO_TIMEOUT_MS = 5_000

/** Better-Auth's GitLab URL cleanup: collapse repeated slashes, keep `://`. */
function cleanDoubleSlashes(input: string): string {
  return input
    .split('://')
    .map((part) => part.replace(/\/{2,}/g, '/'))
    .join('://')
}

/** The endpoints Better-Auth's GitLab provider derives from an issuer. */
export function gitlabEndpoints(issuer: string) {
  return {
    authorizationEndpoint: cleanDoubleSlashes(`${issuer}/oauth/authorize`),
    tokenEndpoint: cleanDoubleSlashes(`${issuer}/oauth/token`),
    userinfoEndpoint: cleanDoubleSlashes(`${issuer}/api/v4/user`),
  }
}

type GitlabProviderOptions = {
  clientId?: unknown
  clientSecret?: unknown
  issuer?: unknown
  mapProfileToUser?: (profile: Record<string, unknown>) => unknown
}

type SocialProvider = Record<string, unknown> & { id?: unknown; options?: GitlabProviderOptions }

/**
 * Replace the GitLab provider's server-side fetches with pinned ones when it
 * has a self-hosted issuer. Mutates in place: the provider objects are created
 * fresh for each auth instance. Returns true when it patched a provider.
 */
export function pinSelfHostedGitlabProvider(providers: unknown): boolean {
  if (!Array.isArray(providers)) return false
  const provider = (providers as Array<SocialProvider | null | undefined>).find(
    (p) => p?.id === 'gitlab'
  )
  const options = provider?.options
  const issuer = typeof options?.issuer === 'string' ? options.issuer : ''
  if (!provider || !options || !issuer) return false

  const { authorizationEndpoint, tokenEndpoint, userinfoEndpoint } = gitlabEndpoints(issuer)
  const endpoints = createOidcEndpointSource({
    authorizationUrl: authorizationEndpoint,
    tokenUrl: tokenEndpoint,
    userInfoUrl: userinfoEndpoint,
  })
  const client = {
    clientId: String(options.clientId ?? ''),
    clientSecret: String(options.clientSecret ?? ''),
    endpoints,
  }
  const exchange = createPinnedTokenExchange(client)
  const mapProfileToUser = options.mapProfileToUser

  provider.validateAuthorizationCode = (data: {
    code: string
    redirectURI: string
    codeVerifier?: string
    deviceId?: string
  }) => exchange(data)
  provider.refreshAccessToken = createPinnedTokenRefresh(client)
  // Mirrors Better-Auth's GitLab getUserInfo, with the fetch pinned.
  provider.getUserInfo = async (token: OAuth2Tokens) => {
    // Undefined when the issuer is not https: the access token is never sent
    // in clear.
    const userEndpoint = endpoints.peek()?.userinfoEndpoint
    if (!userEndpoint) {
      log.warn('self-hosted GitLab issuer is not https; user lookup refused')
      return null
    }
    let profile: Record<string, unknown>
    try {
      profile = await fetchPinnedJson(
        userEndpoint,
        {
          headers: { authorization: `Bearer ${token.accessToken}` },
          timeoutMs: USERINFO_TIMEOUT_MS,
        },
        'GitLab user endpoint'
      )
    } catch (err) {
      log.warn({ err }, 'self-hosted GitLab user lookup failed')
      return null
    }
    if (profile.state !== 'active' || profile.locked) return null
    const userMap = (await mapProfileToUser?.(profile)) as Record<string, unknown> | undefined
    return {
      user: {
        id: profile.id,
        name: profile.name ?? profile.username ?? '',
        email: profile.email,
        image: profile.avatar_url,
        emailVerified: profile.email_verified ?? false,
        ...userMap,
      },
      data: profile,
    }
  }
  return true
}

/**
 * A Better-Auth plugin that pins a self-hosted GitLab provider's fetches. Its
 * `init` runs after Better-Auth has built the social providers.
 */
export function pinSelfHostedGitlab() {
  return {
    id: 'pinned-self-hosted-gitlab',
    init: (ctx: { socialProviders?: unknown }) => {
      pinSelfHostedGitlabProvider(ctx.socialProviders)
      return {}
    },
  }
}
