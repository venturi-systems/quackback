import { describe, it, expect } from 'vitest'
import { buildEventActor } from '../dispatch'
import type { PrincipalId, UserId } from '@quackback/ids'

const pid = 'principal_x' as unknown as PrincipalId
const uid = 'user_x' as unknown as UserId

describe('buildEventActor', () => {
  it('drops the synthetic anonymous placeholder email from the actor', () => {
    // The event actor reaches external webhooks, integrations, and the feedback
    // pipeline — the synthetic anon email must never ride along.
    const actor = buildEventActor({
      principalId: pid,
      userId: uid,
      email: 'temp-ni7j5mnendrdtsjwbesk4mubz4jzszhj@anon.quackback.io',
      displayName: 'Swift Falcon',
    })
    expect(actor.type).toBe('user')
    expect(actor.email).toBeUndefined()
  })

  it('keeps a real user email', () => {
    const actor = buildEventActor({ principalId: pid, userId: uid, email: 'jane@example.com' })
    expect(actor.email).toBe('jane@example.com')
  })

  it('is a service actor (no email) without a userId', () => {
    const actor = buildEventActor({ principalId: pid, displayName: 'linear-integration' })
    expect(actor.type).toBe('service')
    expect(actor.email).toBeUndefined()
  })
})
