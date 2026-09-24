/**
 * Pins the two genericOAuth behaviours that its config cannot reach.
 *
 * `build-oauth-configs.ts` routes discovery, the code exchange and userinfo
 * through `safeFetch` via config hooks. Two gaps remain, and this wrapper
 * closes both without changing the plugin's routes or its id:
 *
 * 1. Refresh. Each plugin provider's `refreshAccessToken` posts to `tokenUrl`
 *    with an unpinned fetch, and Better-Auth's `/refresh-token`,
 *    `/get-access-token` and `/account-info` routes let any signed-in user
 *    trigger it. There is no config hook, so the wrapper swaps the method for
 *    the pinned one. A provider without a pinned refresh has refresh refused.
 *
 * 2. Freshness. The plugin reads `authorizationUrl` / `tokenUrl` / `issuer`
 *    synchronously, and those getters only return a discovery document
 *    fetched within its TTL. A before-hook resolves the document through
 *    `safeFetch` on each route that reads them, so a sign-in never sees an
 *    expired document. When it cannot be resolved the getters stay
 *    undefined and the route fails closed.
 *
 *    The callback routes need more than that. The plugin skips its RFC 9207
 *    `iss` check when the `issuer` getter reads undefined, and the pinned
 *    `getToken` resolves the endpoints again on its own. A resolve that fails
 *    in the hook and succeeds in `getToken` would exchange the code with no
 *    issuer check. So on a callback the hook itself fails closed when the
 *    endpoints cannot be resolved, and compares `iss` against the endpoints
 *    it just resolved. The plugin's own check then runs as a second one.
 *
 * Built-in social providers are not touched: only the provider that
 * Better-Auth would dispatch to for a configured custom-OIDC id is patched.
 */

import { createAuthMiddleware } from 'better-auth/api'
import type { OAuth2Tokens } from 'better-auth/oauth2'
import { logger } from '@/lib/server/logger'
import type { GenericOAuthConfig } from './build-oauth-configs'
import type { OidcEndpoints } from './custom-oidc-fetch'

const log = logger.child({ component: 'custom-oidc-plugin' })

/**
 * Routes that read a custom-OIDC config's endpoints, and where each one names
 * the provider: the plugin's own routes plus Better-Auth's social routes,
 * which dispatch to the same provider objects.
 */
const ENDPOINT_READING_ROUTES: Record<string, { from: 'body' | 'params'; key: string }> = {
  '/sign-in/oauth2': { from: 'body', key: 'providerId' },
  '/oauth2/link': { from: 'body', key: 'providerId' },
  '/oauth2/callback/:providerId': { from: 'params', key: 'providerId' },
  '/sign-in/social': { from: 'body', key: 'provider' },
  '/link-social': { from: 'body', key: 'provider' },
  '/callback/:id': { from: 'params', key: 'id' },
}

/** The callback routes: the ones that exchange a code and check `iss`. */
const CALLBACK_ROUTES = new Set(['/oauth2/callback/:providerId', '/callback/:id'])

type RouteContext = { path?: string; body?: unknown; params?: unknown; query?: unknown }

/**
 * Why a callback must not proceed, as the `error` code the plugin's own
 * callback uses for the same failure.
 */
export type CallbackFailure = 'oauth_code_verification_failed' | 'issuer_mismatch'

/** The provider id a route is about to use, or undefined. */
export function endpointReadingProviderId(ctx: RouteContext): string | undefined {
  const route = ctx.path ? ENDPOINT_READING_ROUTES[ctx.path] : undefined
  if (!route) return undefined
  const source = route.from === 'body' ? ctx.body : ctx.params
  if (!source || typeof source !== 'object') return undefined
  const id = (source as Record<string, unknown>)[route.key]
  return typeof id === 'string' ? id : undefined
}

/** The `iss` query parameter (RFC 9207), or undefined when absent. */
function issParameter(query: unknown): unknown {
  if (!query || typeof query !== 'object') return undefined
  return (query as Record<string, unknown>).iss
}

/**
 * Resolve the endpoints of the custom-OIDC provider a route targets.
 *
 * On a sign-in route a failure is logged and swallowed: the route then reads
 * undefined endpoints and fails closed with the plugin's own configuration
 * error. On a callback route it returns the failure instead, and so does an
 * `iss` parameter that differs from the resolved issuer; the hook turns
 * either into the plugin's error redirect before any code is exchanged.
 */
export async function resolveEndpointsForRoute(
  ctx: RouteContext,
  configsById: ReadonlyMap<string, GenericOAuthConfig>
): Promise<CallbackFailure | undefined> {
  const providerId = endpointReadingProviderId(ctx)
  const pinned = providerId ? configsById.get(providerId)?.pinned : undefined
  if (!pinned) return undefined
  const isCallback = ctx.path !== undefined && CALLBACK_ROUTES.has(ctx.path)
  let endpoints: OidcEndpoints
  try {
    endpoints = await pinned.resolveEndpoints()
  } catch (err) {
    log.warn({ err, providerId }, 'custom OIDC endpoints unavailable; sign-in fails closed')
    return isCallback ? 'oauth_code_verification_failed' : undefined
  }
  if (!isCallback || !endpoints.issuer) return undefined
  const iss = issParameter(ctx.query)
  if (iss !== undefined && iss !== endpoints.issuer) {
    log.warn({ providerId }, 'custom OIDC callback iss does not match the issuer')
    return 'issuer_mismatch'
  }
  return undefined
}

function refuseRefresh(providerId: string) {
  return async (): Promise<OAuth2Tokens> => {
    throw new Error(`Token refresh refused for ${providerId}: no SSRF-pinned token fetch`)
  }
}

/**
 * Swap `refreshAccessToken` on the first provider per custom-OIDC id, which
 * is the one Better-Auth's id lookup dispatches to. Mutates in place: the
 * provider objects are created fresh by the plugin's `init`.
 */
export function pinProviderRefresh(
  initResult: unknown,
  configsById: ReadonlyMap<string, GenericOAuthConfig>
): void {
  const providers = (initResult as { context?: { socialProviders?: unknown } } | null | undefined)
    ?.context?.socialProviders
  if (!Array.isArray(providers)) return
  const patched = new Set<string>()
  for (const provider of providers as Array<Record<string, unknown> | null | undefined>) {
    const id = provider?.id
    if (!provider || typeof id !== 'string' || patched.has(id)) continue
    const config = configsById.get(id)
    if (!config) continue
    provider.refreshAccessToken = config.pinned?.refreshAccessToken ?? refuseRefresh(id)
    patched.add(id)
  }
}

/**
 * Wrap a `genericOAuth(...)` plugin built from `configs` so its refresh path
 * and its endpoint reads go through `safeFetch`. Returns a new plugin object
 * with the same id, endpoints and options.
 */
export function pinCustomOidcFetches<P extends { init?: unknown; hooks?: unknown }>(
  plugin: P,
  configs: readonly GenericOAuthConfig[]
): P {
  const configsById: ReadonlyMap<string, GenericOAuthConfig> = new Map(
    configs.map((c) => [c.providerId, c])
  )
  const init: unknown = plugin.init
  const hooks: { before?: unknown[] } | undefined = plugin.hooks as
    { before?: unknown[] } | undefined

  const pinnedInit = (ctx: unknown): unknown => {
    const result = typeof init === 'function' ? init(ctx) : undefined
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      return (result as Promise<unknown>).then((resolved) => {
        pinProviderRefresh(resolved, configsById)
        return resolved
      })
    }
    pinProviderRefresh(result, configsById)
    return result
  }

  const resolveHook = {
    // Custom-OIDC ids only: built-in social sign-ins never reach the handler.
    matcher: (ctx: RouteContext) => {
      const providerId = endpointReadingProviderId(ctx)
      return providerId !== undefined && configsById.has(providerId)
    },
    handler: createAuthMiddleware(async (ctx) => {
      const failure = await resolveEndpointsForRoute(ctx, configsById)
      if (!failure) return
      // The same redirect the plugin's callback makes for these failures.
      const errorURL = ctx.context.options.onAPIError?.errorURL || `${ctx.context.baseURL}/error`
      const separator = errorURL.includes('?') ? '&' : '?'
      throw ctx.redirect(`${errorURL}${separator}${new URLSearchParams({ error: failure })}`)
    }),
  }

  return {
    ...plugin,
    init: pinnedInit,
    hooks: { ...hooks, before: [...(hooks?.before ?? []), resolveHook] },
  }
}
