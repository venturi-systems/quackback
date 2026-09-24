/**
 * Account-linking trust (`account.accountLinking.trustedProviders`).
 *
 * Better Auth 1.6 skips the provider's own `emailVerified` when a TRUSTED
 * provider links itself to an existing account with the same address. The
 * team identity rule reads the account's own verified flag and linked
 * providers, so a trusted Google or GitHub identity reporting an unverified
 * address equal to an administrator's would be signed in AS that
 * administrator. Built-in social providers must therefore never be trusted.
 */
import { describe, expect, it } from 'vitest'
import { linkingTrustedProviderIds } from '../linking-trust'

describe('linkingTrustedProviderIds', () => {
  it('never trusts Google or GitHub', () => {
    const trusted = linkingTrustedProviderIds({
      oidcProviderIds: [],
      socialProviderIds: ['google', 'github'],
    })
    expect(trusted).toEqual([])
  })

  it('never trusts any built-in social provider, whichever are registered', () => {
    const trusted = linkingTrustedProviderIds({
      oidcProviderIds: ['sso'],
      socialProviderIds: ['google', 'github', 'microsoft', 'gitlab'],
    })
    expect(trusted).toEqual(['sso'])
    for (const social of ['google', 'github', 'microsoft', 'gitlab']) {
      expect(trusted).not.toContain(social)
    }
  })

  it('keeps administrator-registered OIDC providers trusted', () => {
    expect(
      linkingTrustedProviderIds({
        oidcProviderIds: ['sso', 'custom-oidc', 'oidc_idp_abc'],
        socialProviderIds: ['google'],
      })
    ).toEqual(['sso', 'custom-oidc', 'oidc_idp_abc'])
  })

  it('refuses an OIDC registration id that collides with a social provider id', () => {
    // Trust is matched by provider id, so a colliding id would extend trust
    // to the social provider of the same name.
    expect(
      linkingTrustedProviderIds({
        oidcProviderIds: ['github', 'sso', 'sso'],
        socialProviderIds: ['github'],
      })
    ).toEqual(['sso'])
  })
})
