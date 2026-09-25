/**
 * URL routing utilities
 *
 * Simplified for single workspace OSS deployment.
 */

/** A base no request is ever served from, so a same-origin check can resolve against it. */
const CALLBACK_BASE = 'https://callback.invalid'

/** Whether `value` holds a C0 control character or DEL. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * The path a `/`-prefixed callback URL resolves to on this origin, after the
 * URL parser has applied its dot segments (`.`, `..`, `%2e%2e`), or null when
 * it is not a same-origin relative path.
 */
function resolvedCallbackPath(url: string): string | null {
  if (!url.startsWith('/')) return null
  try {
    const resolved = new URL(url, CALLBACK_BASE)
    return resolved.origin === CALLBACK_BASE ? resolved.pathname : null
  } catch {
    return null
  }
}

/**
 * Same-origin safety check for callback / redirect URLs:
 * `/`-prefixed AND not protocol-relative (`//evil.com/x` would otherwise
 * look local). Used by every callback-URL handler so the rule lives in
 * one place.
 *
 * A browser drops tab, CR and LF anywhere in a URL before it resolves it, so
 * `/\t/evil.com` would navigate as `//evil.com`. Every control character is
 * therefore refused, and the value must still resolve to this origin when a
 * URL parser reads it.
 *
 * Dot segments are applied before the path is read, so `/.//evil.com` and
 * `/admin/..//evil.com`, which resolve to the path `//evil.com`, are refused
 * like `//evil.com` itself: a later hop that reads that path on its own, such
 * as a proxy that collapses slashes, must never see a protocol-relative path.
 */
export function isSafeCallbackUrl(url: unknown): url is string {
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    !url.startsWith('/') ||
    url.startsWith('//') ||
    url.includes('\\') ||
    hasControlCharacter(url)
  ) {
    return false
  }
  const path = resolvedCallbackPath(url)
  return path !== null && !path.startsWith('//')
}

/** True when a (safe, relative) callback URL targets a team surface, so the
 *  login should serve the always-on team form (break-glass), not the public
 *  portal form. Covers /admin and the team-invitation accept flow.
 *  Matches each prefix exactly or as a path segment — never `/administrator…`.
 *  Only the path counts, so `/admin?post=…` and `/admin#x` are team pages.
 *  The path is read as the browser will resolve it, so `/admin/../b/ideas`
 *  (which lands on `/b/ideas`) is not a team page. */
export function isTeamCallback(callbackUrl: string | undefined): boolean {
  if (!callbackUrl) return false
  const path = resolvedCallbackPath(callbackUrl)
  if (path === null) return false
  const teamPrefixes = ['/admin', '/complete-signup']
  return teamPrefixes.some((p) => path === p || path.startsWith(p + '/'))
}

/**
 * Where a signed-out visitor on a team page returns after signing in: the
 * page they asked for, with its query and fragment, when it is a safe
 * same-origin team path, and the admin home otherwise.
 */
export function teamSigninCallback(requested: unknown): string {
  return isSafeCallbackUrl(requested) && isTeamCallback(requested) ? requested : '/admin'
}
