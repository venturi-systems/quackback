/**
 * OAuth client registration policy (landing-page#2309): no registration
 * without a session, with no switch to turn it on, and read-only default
 * scopes for a dynamically registered client.
 */
import { describe, it, expect } from 'vitest'
import {
  ALLOW_UNAUTHENTICATED_CLIENT_REGISTRATION,
  OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES,
} from '../oauth-client-defaults'

describe('OAuth client registration policy', () => {
  it('never allows registration without a signed-in session', () => {
    expect(ALLOW_UNAUTHENTICATED_CLIENT_REGISTRATION).toBe(false)
  })

  it('gives a registered client read-only scopes by default', () => {
    const writes = OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES.filter((scope) =>
      scope.startsWith('write:')
    )
    expect(writes).toEqual([])
    expect(OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES).toContain('read:feedback')
  })
})
