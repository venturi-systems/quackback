/**
 * The settings fields an external policy process may declare as managed
 * through POLICY_MANAGED_SETTINGS (lib/server/config.ts).
 *
 * Each path names exactly the value the policy process writes, and covers the
 * fields beneath it but never its siblings (isPathManaged). For Venturi the
 * policy process is the feedback infrastructure repository's reconciler:
 * `auth.oauth` is the whole provider map because the reconciler replaces it,
 * while `portal.access.visibility` is one key of the access object. Shared by
 * the server guards and the admin UI so both read one grammar.
 */
export const POLICY_MANAGED_PATH_OPTIONS = [
  'portal.access.visibility',
  'portal.features.allowAnonymous',
  'portal.oauth',
  'auth.oauth',
  'auth.openSignup',
] as const

/** `boards.<slug>.access`: the access policy of the one board with that slug. */
const BOARD_ACCESS_PATH = /^boards\.[a-z0-9][a-z0-9-]*\.access$/
/** `auth.oauth.<method>`: one sign-in method, when the process owns only some. */
const AUTH_OAUTH_METHOD_PATH = /^auth\.oauth\.[A-Za-z][A-Za-z0-9-]*$/

/** The managed path for one board's access policy, moderation included. */
export function boardAccessManagedPath(slug: string): string {
  return `boards.${slug}.access`
}

/** The managed path for one sign-in method in the `auth.oauth` map. */
export function authOauthManagedPath(methodId: string): string {
  return `auth.oauth.${methodId}`
}

export function isPolicyManagedPathOption(path: string): boolean {
  return (
    (POLICY_MANAGED_PATH_OPTIONS as readonly string[]).includes(path) ||
    BOARD_ACCESS_PATH.test(path) ||
    AUTH_OAUTH_METHOD_PATH.test(path)
  )
}
