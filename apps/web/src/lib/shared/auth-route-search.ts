import { z } from 'zod'
import { searchChoice, searchText } from './search-params'

/**
 * `validateSearch` schemas for the sign-in, account and OAuth routes.
 *
 * They follow the rule `search-params.ts` sets for every route: a hostile or
 * malformed query string never fails validation. TanStack Router reads each
 * value through `JSON.parse` first, so `?error=123` arrives as the number
 * `123`, and a schema that demands a string raises a SearchParamError. The
 * server answered that with HTTP 500 and dehydrated the raw zod issue
 * ("Invalid input: expected string, received number") into the page. That was
 * DEF-55 on `/auth/login?error=123`, `/auth/login?callbackUrl=123`,
 * `/admin/login?error=123` and `/auth/signup?callbackUrl=123`.
 *
 * The schemas live here rather than in the route files so tests can drive them
 * without loading each route's components and server functions.
 */

const textValue = searchText()

/**
 * A query value read as text (`searchText`), or undefined for any other shape,
 * for routes whose `validateSearch` is a plain function. It never throws.
 */
export function queryText(value: unknown): string | undefined {
  return textValue.parse(value)
}

/**
 * `/auth/login`, `/auth/signup` and `/admin/login`: where to go after signing
 * in and the code that explains a refused sign-in. Both are text; the
 * redirect target still checks `callbackUrl` with `isSafeCallbackUrl`, and
 * only a known code (`authBlockMessage`) ever shows a message.
 */
export const signinRedirectSearch = z.object({
  callbackUrl: searchText(),
  error: searchText(),
})

/**
 * A query value of a signed OAuth request, kept in the exact shape the parser
 * delivered it.
 *
 * The consent page posts its own query string back (`oauth_query`), and the
 * authorization server checks it against the signature it issued. On the
 * server the router redirects to the URL built from the validated values, so a
 * value must validate to what the parser read: turning the number `12345` into
 * the text `'12345'` would make that URL `state=%2212345%22`, which is a
 * different state. A number or boolean therefore stays as it is, and only a
 * shape no OAuth parameter takes (a list, an object, null) reads as absent.
 */
const oauthValue = z.union([z.string(), z.number(), z.boolean()]).optional().catch(undefined)

/**
 * `/oauth/consent`. `client_id` is optional here so a request without one
 * renders the page's own error instead of failing validation.
 */
export const oauthConsentSearch = z.object({
  client_id: oauthValue,
  scope: oauthValue,
  redirect_uri: oauthValue,
  state: oauthValue,
  response_type: oauthValue,
  code_challenge: oauthValue,
  code_challenge_method: oauthValue,
  prompt: oauthValue,
  exp: oauthValue,
  sig: oauthValue,
  resource: oauthValue,
})

/** An OAuth query value as text for display or lookup, or undefined. */
export function oauthText(value: string | number | boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value)
}

/** `/auth/widget-handoff`: the one-time token and the portal path to return to. */
export const widgetHandoffSearch = z.object({
  ott: searchText(),
  returnTo: searchText(),
})

/** `/auth/reset-password`: the reset token and the error code, empty when absent. */
export function resetPasswordSearch(search: Record<string, unknown>): {
  token: string
  error: string
} {
  return {
    token: queryText(search.token) ?? '',
    error: queryText(search.error) ?? '',
  }
}

/** `/verify-magic-link`: the token and better-auth's callback URLs. */
export function magicLinkSearch(search: Record<string, unknown>): {
  token?: string
  callbackURL?: string
  errorCallbackURL?: string
} {
  return {
    token: queryText(search.token) || undefined,
    callbackURL: queryText(search.callbackURL) || undefined,
    errorCallbackURL: queryText(search.errorCallbackURL) || undefined,
  }
}

/** `/complete-signup/$id`: the invitation error code. */
export function completeSignupSearch(search: Record<string, unknown>): { error?: string } {
  return { error: queryText(search.error) || undefined }
}

/** The tabs of Admin > Security > Authentication. */
export const AUTH_SETTINGS_TABS = ['portal-access', 'sign-in'] as const

/**
 * `/admin/settings/security/authentication`: the open tab, a closed choice.
 * The retired `team-access` tab reads as `sign-in` so old bookmarks still
 * open the right tab; any other value opens the default tab.
 */
export const authSettingsSearch = z.object({
  tab: z.preprocess((v) => (v === 'team-access' ? 'sign-in' : v), searchChoice(AUTH_SETTINGS_TABS)),
})
