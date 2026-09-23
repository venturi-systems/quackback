/**
 * Unauthenticated OAuth dynamic client registration is opt-in. Only the
 * literal string 'true' in OAUTH_ALLOW_UNAUTHENTICATED_CLIENT_REGISTRATION
 * enables it; anything else (unset, 'false', '1', typos) keeps it off.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { config } from '../config'

const KEY = 'OAUTH_ALLOW_UNAUTHENTICATED_CLIENT_REGISTRATION'
const original = process.env[KEY]

afterEach(() => {
  if (original === undefined) delete process.env[KEY]
  else process.env[KEY] = original
})

describe('config.oauthAllowUnauthenticatedClientRegistration', () => {
  it('is off when the variable is unset', () => {
    delete process.env[KEY]
    expect(config.oauthAllowUnauthenticatedClientRegistration).toBe(false)
  })

  it.each(['false', '1', 'TRUE', 'yes', ''])('is off for %j', (value) => {
    process.env[KEY] = value
    expect(config.oauthAllowUnauthenticatedClientRegistration).toBe(false)
  })

  it("is on only for the literal 'true'", () => {
    process.env[KEY] = 'true'
    expect(config.oauthAllowUnauthenticatedClientRegistration).toBe(true)
  })
})
