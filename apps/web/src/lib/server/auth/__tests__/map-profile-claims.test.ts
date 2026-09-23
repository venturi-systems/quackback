import { describe, it, expect } from 'vitest'
import { mapOidcProfileClaims, mapProfileLocale } from '../map-profile-claims'

describe('mapProfileLocale (social providers)', () => {
  it('takes a non-empty string locale', () => {
    expect(mapProfileLocale({ locale: 'pt-BR' })).toEqual({ locale: 'pt-BR' })
  })

  it('nulls an absent, empty, or non-string locale', () => {
    expect(mapProfileLocale({}).locale).toBeNull()
    expect(mapProfileLocale({ locale: '' }).locale).toBeNull()
    expect(mapProfileLocale({ locale: 42 }).locale).toBeNull()
    expect(mapProfileLocale(null).locale).toBeNull()
    expect(mapProfileLocale(undefined).locale).toBeNull()
  })

  it('never sets emailVerified, so a GitHub profile keeps the /user/emails verdict', () => {
    // GitHub's /user profile has no email_verified claim. Better Auth derives
    // the flag from /user/emails and then spreads this hook's result over it,
    // so returning emailVerified here would overwrite a verified GitHub
    // address with false (the upstream 282775c7d regression).
    const githubProfile = { id: 1, login: 'octo', email: 'octo@example.com' }
    expect(mapProfileLocale(githubProfile)).not.toHaveProperty('emailVerified')
    expect(mapProfileLocale({ email_verified: 'false' })).not.toHaveProperty('emailVerified')
  })
})

describe('mapOidcProfileClaims (generic OIDC providers)', () => {
  it('honours a literal boolean true and the string "true"', () => {
    expect(mapOidcProfileClaims({ email_verified: true }).emailVerified).toBe(true)
    expect(mapOidcProfileClaims({ email_verified: 'true' }).emailVerified).toBe(true)
    expect(mapOidcProfileClaims({ email_verified: 'TRUE' }).emailVerified).toBe(true)
  })

  it('does NOT treat the string "false" as verified', () => {
    expect(mapOidcProfileClaims({ email_verified: 'false' }).emailVerified).toBe(false)
    expect(mapOidcProfileClaims({ email_verified: 'False' }).emailVerified).toBe(false)
  })

  it('rejects every other truthy-but-not-affirmative shape', () => {
    expect(mapOidcProfileClaims({ email_verified: 1 }).emailVerified).toBe(false)
    expect(mapOidcProfileClaims({ email_verified: 'yes' }).emailVerified).toBe(false)
    expect(mapOidcProfileClaims({ email_verified: {} }).emailVerified).toBe(false)
    expect(mapOidcProfileClaims({ email_verified: [] }).emailVerified).toBe(false)
    expect(mapOidcProfileClaims({ email_verified: null }).emailVerified).toBe(false)
    expect(mapOidcProfileClaims({ email_verified: false }).emailVerified).toBe(false)
  })

  it('leaves emailVerified unset when the claim is absent', () => {
    expect(mapOidcProfileClaims({})).not.toHaveProperty('emailVerified')
    expect(mapOidcProfileClaims(null)).not.toHaveProperty('emailVerified')
    expect(mapOidcProfileClaims({ locale: 'fr' })).toEqual({ locale: 'fr' })
  })
})
