/**
 * Claim normalisation for OAuth/OIDC profiles, applied through Better Auth's
 * `mapProfileToUser` hook.
 *
 * Better Auth spreads the hook's return value OVER the user info it resolved,
 * so any key returned here wins. That is how `email_verified` is tightened for
 * generic OIDC providers without patching the library.
 *
 * Adapted from upstream QuackbackIO/quackback 282775c7d ("coerce
 * email_verified strictly instead of by truthiness"). Upstream applies the
 * coercion to every provider, including the built-in social providers. That
 * is wrong for GitHub: its `/user` profile carries no `email_verified` claim,
 * Better Auth derives the flag from `/user/emails` instead, and an
 * unconditional coercion would overwrite that with `false` for every GitHub
 * user. Here the coercion runs only for generic OIDC providers, and only when
 * the claim is actually present in the profile.
 *
 * Pure and standalone (no DB, no config) so the rules are unit-testable.
 */

/**
 * OIDC Core types `email_verified` as a boolean, but SAML-to-OIDC bridges
 * routinely stringify it, and the string `"false"` is truthy. Affirmative
 * means literal `true` or the exact (case-insensitive) string `"true"`;
 * everything else is false.
 */
export function claimIsAffirmative(value: unknown): boolean {
  if (value === true) return true
  return typeof value === 'string' && value.toLowerCase() === 'true'
}

function readLocale(profile: unknown): string | null {
  const p = profile as { locale?: unknown } | null | undefined
  return typeof p?.locale === 'string' && p.locale.length > 0 ? p.locale : null
}

/**
 * Declared as type aliases rather than interfaces deliberately: Better Auth
 * types the hook's return as `Record<string, unknown>`, and TypeScript grants
 * an implicit index signature to type aliases but not to interfaces.
 */
export type MappedLocaleClaims = { locale: string | null }
export type MappedOidcClaims = { locale: string | null; emailVerified?: boolean }

/** Built-in social providers (Google, GitHub, ...): locale passthrough only. */
export function mapProfileLocale(profile: unknown): MappedLocaleClaims {
  return { locale: readLocale(profile) }
}

/**
 * Generic OIDC providers: locale passthrough plus a strict `email_verified`
 * coercion, applied only when the profile carries the claim. An absent claim
 * leaves Better Auth's own value untouched.
 */
export function mapOidcProfileClaims(profile: unknown): MappedOidcClaims {
  const mapped: MappedOidcClaims = { locale: readLocale(profile) }
  if (
    profile !== null &&
    typeof profile === 'object' &&
    Object.prototype.hasOwnProperty.call(profile, 'email_verified')
  ) {
    mapped.emailVerified = claimIsAffirmative(
      (profile as { email_verified?: unknown }).email_verified
    )
  }
  return mapped
}
