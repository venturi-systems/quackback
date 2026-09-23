import { describe, it, expect } from 'vitest'
import { allowDecision, denyDecision, isAllowed, isTeamActor, ANONYMOUS_ACTOR } from '../types'
import type { Actor } from '../types'

describe('policy decisions', () => {
  it('allowDecision returns an allowed decision', () => {
    const decision = allowDecision()
    expect(decision.allowed).toBe(true)
    expect(isAllowed(decision)).toBe(true)
  })

  it('denyDecision carries a reason string', () => {
    const decision = denyDecision('not in audience')
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toBe('not in audience')
    }
    expect(isAllowed(decision)).toBe(false)
  })

  it('ANONYMOUS_ACTOR has empty segment set, anonymous principal type, no role', () => {
    expect(ANONYMOUS_ACTOR.principalId).toBeNull()
    expect(ANONYMOUS_ACTOR.role).toBeNull()
    expect(ANONYMOUS_ACTOR.principalType).toBe('anonymous')
    expect(ANONYMOUS_ACTOR.segmentIds.size).toBe(0)
  })
})

describe('isTeamActor', () => {
  const actor = (role: Actor['role'], principalType: Actor['principalType']): Actor => ({
    principalId: null,
    role,
    principalType,
    segmentIds: new Set(),
  })

  it('treats human and service admins/members as team', () => {
    expect(isTeamActor(actor('admin', 'user'))).toBe(true)
    expect(isTeamActor(actor('member', 'user'))).toBe(true)
    expect(isTeamActor(actor('admin', 'service'))).toBe(true)
  })

  it('never treats an anonymous principal as team, even with a stored team role', () => {
    expect(isTeamActor(actor('admin', 'anonymous'))).toBe(false)
    expect(isTeamActor(actor('member', 'anonymous'))).toBe(false)
  })

  it('does not treat portal users or the anonymous actor as team', () => {
    expect(isTeamActor(actor('user', 'user'))).toBe(false)
    expect(isTeamActor(ANONYMOUS_ACTOR)).toBe(false)
  })
})
