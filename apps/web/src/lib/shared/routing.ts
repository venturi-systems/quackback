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
 * Same-origin safety check for callback / redirect URLs:
 * `/`-prefixed AND not protocol-relative (`//evil.com/x` would otherwise
 * look local). Used by every callback-URL handler so the rule lives in
 * one place.
 *
 * A browser drops tab, CR and LF anywhere in a URL before it resolves it, so
 * `/\t/evil.com` would navigate as `//evil.com`. Every control character is
 * therefore refused, and the value must still resolve to this origin when a
 * URL parser reads it.
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
  try {
    return new URL(url, CALLBACK_BASE).origin === CALLBACK_BASE
  } catch {
    return false
  }
}

/** True when a (safe, relative) callback URL targets a team surface, so the
 *  login should serve the always-on team form (break-glass), not the public
 *  portal form. Covers /admin and the team-invitation accept flow.
 *  Matches each prefix exactly or as a path segment — never `/administrator…`.
 *  Only the path counts, so `/admin?post=…` and `/admin#x` are team pages. */
export function isTeamCallback(callbackUrl: string | undefined): boolean {
  if (!callbackUrl) return false
  const path = callbackUrl.split(/[?#]/, 1)[0]
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
