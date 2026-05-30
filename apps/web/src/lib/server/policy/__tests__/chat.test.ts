/**
 * Authorization matrix for live chat. Pure-function policy: who may read a
 * conversation, post as the visitor, start a conversation, or act as an agent.
 */
import { describe, it, expect } from 'vitest'
import {
  canViewConversation,
  canSendVisitorMessage,
  canStartConversation,
  canActAsAgent,
  type ConversationShape,
} from '../chat'
import { ANONYMOUS_ACTOR, type Actor } from '../types'
import type { PrincipalId } from '@quackback/ids'

const VISITOR = 'principal_visitor' as PrincipalId
const OTHER = 'principal_other' as PrincipalId

const visitorActor: Actor = {
  principalId: VISITOR,
  role: 'user',
  principalType: 'user',
  segmentIds: new Set(),
}

const anonVisitorActor: Actor = {
  principalId: VISITOR,
  role: 'user',
  principalType: 'anonymous',
  segmentIds: new Set(),
}

const otherVisitorActor: Actor = {
  principalId: OTHER,
  role: 'user',
  principalType: 'user',
  segmentIds: new Set(),
}

const adminActor: Actor = {
  principalId: 'principal_admin' as PrincipalId,
  role: 'admin',
  principalType: 'user',
  segmentIds: new Set(),
}

const memberActor: Actor = {
  principalId: 'principal_member' as PrincipalId,
  role: 'member',
  principalType: 'user',
  segmentIds: new Set(),
}

const serviceActor: Actor = {
  principalId: 'principal_service' as PrincipalId,
  role: 'member',
  principalType: 'service',
  segmentIds: new Set(),
}

const openConv: ConversationShape = { visitorPrincipalId: VISITOR, status: 'open' }
const closedConv: ConversationShape = { visitorPrincipalId: VISITOR, status: 'closed' }

describe('canViewConversation', () => {
  it('allows the owning visitor', () => {
    expect(canViewConversation(visitorActor, openConv).allowed).toBe(true)
    expect(canViewConversation(anonVisitorActor, openConv).allowed).toBe(true)
  })

  it('allows team members (admin + member) to view any conversation', () => {
    expect(canViewConversation(adminActor, openConv).allowed).toBe(true)
    expect(canViewConversation(memberActor, openConv).allowed).toBe(true)
  })

  it('denies a different visitor', () => {
    expect(canViewConversation(otherVisitorActor, openConv).allowed).toBe(false)
  })

  it('denies a fully anonymous actor with no principal', () => {
    expect(canViewConversation(ANONYMOUS_ACTOR, openConv).allowed).toBe(false)
  })
})

describe('canSendVisitorMessage', () => {
  it('allows the owning visitor (open or closed — replying reopens)', () => {
    expect(canSendVisitorMessage(visitorActor, openConv).allowed).toBe(true)
    expect(canSendVisitorMessage(visitorActor, closedConv).allowed).toBe(true)
    expect(canSendVisitorMessage(anonVisitorActor, openConv).allowed).toBe(true)
  })

  it('denies a non-owner', () => {
    expect(canSendVisitorMessage(otherVisitorActor, openConv).allowed).toBe(false)
  })

  it('denies an actor with no principal', () => {
    expect(canSendVisitorMessage(ANONYMOUS_ACTOR, openConv).allowed).toBe(false)
  })

  it('denies service principals', () => {
    const conv: ConversationShape = {
      visitorPrincipalId: serviceActor.principalId!,
      status: 'open',
    }
    expect(canSendVisitorMessage(serviceActor, conv).allowed).toBe(false)
  })
})

describe('canStartConversation', () => {
  it('allows any identified or anonymous visitor with a principal', () => {
    expect(canStartConversation(visitorActor).allowed).toBe(true)
    expect(canStartConversation(anonVisitorActor).allowed).toBe(true)
  })

  it('denies actors with no principal', () => {
    expect(canStartConversation(ANONYMOUS_ACTOR).allowed).toBe(false)
  })

  it('denies service principals', () => {
    expect(canStartConversation(serviceActor).allowed).toBe(false)
  })
})

describe('canActAsAgent', () => {
  it('allows team members only', () => {
    expect(canActAsAgent(adminActor).allowed).toBe(true)
    expect(canActAsAgent(memberActor).allowed).toBe(true)
  })

  it('denies portal users and anonymous visitors', () => {
    expect(canActAsAgent(visitorActor).allowed).toBe(false)
    expect(canActAsAgent(anonVisitorActor).allowed).toBe(false)
    expect(canActAsAgent(ANONYMOUS_ACTOR).allowed).toBe(false)
  })
})
