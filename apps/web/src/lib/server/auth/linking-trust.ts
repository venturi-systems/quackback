/**
 * Which sign-in providers Better Auth may treat as "trusted" for account
 * linking (`account.accountLinking.trustedProviders`).
 *
 * A trusted provider may link itself to an existing account with the same
 * address even when the provider reports that address UNVERIFIED (Better Auth
 * 1.6: oauth2/link-account, the OAuth callback's link branch and linkSocial all
 * skip the provider's `emailVerified` for a trusted provider). A session on the
 * linked account then carries whatever role the account holds, and the team
 * identity rule reads the account's own verified flag and linked providers
 * (domains/principals/team-identity.ts). So a trusted social provider would let
 * an identity that never proved the address sign in as an administrator.
 *
 * Only administrator-registered OIDC providers are trusted: an administrator
 * registered each one for the domains it vouches for, which is the single
 * sign-on trust model. Built-in social providers (Google, GitHub, and the rest)
 * are never trusted, so they link only when they themselves report the address
 * verified AND the local account is already verified
 * (`requireLocalEmailVerified`, Better Auth's default).
 */
export function linkingTrustedProviderIds(input: {
  /** Better Auth provider ids of the registered OIDC providers. */
  oidcProviderIds: readonly string[]
  /** Ids of the built-in social providers registered on the instance. */
  socialProviderIds: readonly string[]
}): string[] {
  const social = new Set(input.socialProviderIds)
  // A registration id that collides with a social provider id is refused too:
  // Better Auth matches trust by provider id, not by provider kind.
  return [...new Set(input.oidcProviderIds)].filter((id) => !social.has(id))
}
