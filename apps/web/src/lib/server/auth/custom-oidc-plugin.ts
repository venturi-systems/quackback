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
 * Built-in social providers are not touched: only the provider that
 * Better-Auth would dispatch to for a configured custom-OIDC id is patched.
 */

import { createAuthMiddleware } from 'better-auth/api'
import type { OAuth2Tokens } from 'better-auth/oauth2'
import { logger } from '@/lib/server/logger'
import type { GenericOAuthConfig } from './build-oauth-configs'

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

type RouteContext = { path?: string; body?: unknown; params?: unknown }

/** The provider id a route is about to use, or undefined. */
export function endpointReadingProviderId(ctx: RouteContext): string | undefined {
  const route = ctx.path ? ENDPOINT_READING_ROUTES[ctx.path] : undefined
  if (!route) return undefined
  const source = route.from === 'body' ? ctx.body : ctx.params
  if (!source || typeof source !== 'object') return undefined
  const id = (source as Record<string, unknown>)[route.key]
  return typeof id === 'string' ? id : undefined
}

/**
 * Resolve the endpoints of the custom-OIDC provider a route targets. A failure
 * is logged and swallowed: the route then reads undefined endpoints and fails
 * closed with the plugin's own configuration error.
 */
export async function resolveEndpointsForRoute(
  ctx: RouteContext,
  configsById: ReadonlyMap<string, GenericOAuthConfig>
): Promise<void> {
  const providerId = endpointReadingProviderId(ctx)
  const pinned = providerId ? configsById.get(providerId)?.pinned : undefined
  if (!pinned) return
  try {
    await pinned.resolveEndpoints()
  } catch (err) {
    log.warn({ err, providerId }, 'custom OIDC endpoints unavailable; sign-in fails closed')
  }
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
    | { before?: unknown[] }
    | undefined

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
      await resolveEndpointsForRoute(ctx, configsById)
    }),
  }

  return {
    ...plugin,
    init: pinnedInit,
    hooks: { ...hooks, before: [...(hooks?.before ?? []), resolveHook] },
  }
}
