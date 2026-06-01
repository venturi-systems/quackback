/**
 * Applying an agent macro runs its present actions through the normal chat
 * service in a fixed order (reply → priority → assign → status), skipping any
 * action the macro doesn't set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationId, PrincipalId } from '@quackback/ids'
import type { Actor } from '@/lib/server/policy/types'
import type { ChatMacro } from '@/lib/server/domains/settings/settings.types'

const sendAgentMessage = vi.fn()
const setConversationPriority = vi.fn()
const assignConversation = vi.fn()
const setConversationStatus = vi.fn()

vi.mock('../chat.service', () => ({
  sendAgentMessage: (...a: unknown[]) => sendAgentMessage(...a),
  setConversationPriority: (...a: unknown[]) => setConversationPriority(...a),
  assignConversation: (...a: unknown[]) => assignConversation(...a),
  setConversationStatus: (...a: unknown[]) => setConversationStatus(...a),
}))

import { applyMacro } from '../chat.macros'

const conversationId = 'conversation_1' as ConversationId
const agent = { principalId: 'principal_agent' as PrincipalId, displayName: 'Agent' }
const actor: Actor = {
  principalId: 'principal_agent' as PrincipalId,
  role: 'admin',
  principalType: 'user',
  segmentIds: new Set(),
}

beforeEach(() => {
  vi.clearAllMocks()
  sendAgentMessage.mockResolvedValue({})
  setConversationPriority.mockResolvedValue(undefined)
  assignConversation.mockResolvedValue(undefined)
  setConversationStatus.mockResolvedValue(undefined)
})

describe('applyMacro', () => {
  it('runs all present actions in order: reply → priority → assign → status', async () => {
    const macro: ChatMacro = {
      id: 'macro_1',
      name: 'Resolve + thanks',
      replyBody: 'Thanks for reaching out!',
      setPriority: 'low',
      assignToSelf: true,
      setStatus: 'closed',
    }

    const result = await applyMacro(conversationId, macro, agent, actor)

    expect(result.applied).toEqual(['reply', 'priority', 'assign', 'status'])
    expect(sendAgentMessage).toHaveBeenCalledWith(
      conversationId,
      'Thanks for reaching out!',
      agent,
      actor
    )
    expect(setConversationPriority).toHaveBeenCalledWith(conversationId, 'low', actor)
    expect(assignConversation).toHaveBeenCalledWith(conversationId, 'principal_agent', actor)
    expect(setConversationStatus).toHaveBeenCalledWith(conversationId, 'closed', actor)

    // Fixed order: reply before status so the close happens last.
    const order = [
      sendAgentMessage.mock.invocationCallOrder[0],
      setConversationPriority.mock.invocationCallOrder[0],
      assignConversation.mock.invocationCallOrder[0],
      setConversationStatus.mock.invocationCallOrder[0],
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('skips actions the macro does not set', async () => {
    const macro: ChatMacro = { id: 'm', name: 'Just close', setStatus: 'closed' }

    const result = await applyMacro(conversationId, macro, agent, actor)

    expect(result.applied).toEqual(['status'])
    expect(sendAgentMessage).not.toHaveBeenCalled()
    expect(setConversationPriority).not.toHaveBeenCalled()
    expect(assignConversation).not.toHaveBeenCalled()
    expect(setConversationStatus).toHaveBeenCalledTimes(1)
  })

  it('treats a blank reply body as no reply', async () => {
    const macro: ChatMacro = { id: 'm', name: 'blank', replyBody: '   ', setPriority: 'high' }

    const result = await applyMacro(conversationId, macro, agent, actor)

    expect(result.applied).toEqual(['priority'])
    expect(sendAgentMessage).not.toHaveBeenCalled()
  })

  it('does not assign when the actor has no principal id', async () => {
    const macro: ChatMacro = { id: 'm', name: 'assign', assignToSelf: true }
    const anon: Actor = { ...actor, principalId: null }

    const result = await applyMacro(conversationId, macro, agent, anon)

    expect(result.applied).toEqual([])
    expect(assignConversation).not.toHaveBeenCalled()
  })
})
