/**
 * Security-critical guards for internal notes: they are agent-only and must
 * never reach the visitor. We assert the note is written with isInternal=true,
 * published ONLY to the agent inbox channel (never the visitor's conversation
 * channel), and refused for non-agent actors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrincipalId, ConversationId } from '@quackback/ids'
import type { Actor } from '@/lib/server/policy/types'
import { ForbiddenError, ValidationError } from '@/lib/shared/errors'

const insertedMessages: Record<string, unknown>[] = []
const publishChatEvent = vi.fn()
const publishAgentChatEvent = vi.fn()
const notifyNoteMentions = vi.fn()

vi.mock('@/lib/server/realtime/chat-channels', () => ({
  publishChatEvent: (...args: unknown[]) => publishChatEvent(...args),
  publishAgentChatEvent: (...args: unknown[]) => publishAgentChatEvent(...args),
}))

vi.mock('@/lib/server/config', () => ({
  config: { s3PublicUrl: undefined, baseUrl: 'http://localhost:3000' },
  getBaseUrl: () => 'http://localhost:3000',
}))

vi.mock('../chat.notify', () => ({
  notifyVisitorMessage: vi.fn(),
  notifyAgentReply: vi.fn(),
  notifyNoteMentions: (...args: unknown[]) => notifyNoteMentions(...args),
}))

vi.mock('../chat.query', () => ({
  conversationToDTO: vi.fn(async (c: { id: string; status: string }) => ({
    id: c.id,
    status: c.status,
  })),
  toMessageDTO: vi.fn((m: Record<string, unknown>) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderType: m.senderType,
    isInternal: m.isInternal,
    content: m.content,
    author: { principalId: m.principalId, displayName: null, avatarUrl: null },
  })),
  authorFromInput: vi.fn((a: { principalId: string }) => ({
    principalId: a.principalId,
    displayName: null,
    avatarUrl: null,
  })),
  loadAuthors: vi.fn(async () => new Map()),
}))

vi.mock('@/lib/server/db', () => {
  const conversationRow = {
    id: 'conversation_1' as unknown as ConversationId,
    visitorPrincipalId: 'principal_visitor',
    assignedAgentPrincipalId: null,
    status: 'open',
    subject: null,
    lastMessagePreview: null,
    lastMessageAt: new Date(),
    visitorLastReadAt: null,
    agentLastReadAt: null,
    createdAt: new Date(),
    updatedAt: null,
  }

  function chain(label: string) {
    const c: Record<string, unknown> = {}
    c.values = vi.fn((row: Record<string, unknown>) => {
      if (label === 'chat_messages') insertedMessages.push(row)
      return c
    })
    c.set = vi.fn(() => c)
    c.from = vi.fn(() => c)
    c.where = vi.fn(() => c)
    // loadConversationOr404 resolves to an existing conversation.
    c.limit = vi.fn(async () => [conversationRow])
    c.orderBy = vi.fn(() => c)
    c.returning = vi.fn(async () => {
      if (label === 'chat_messages') {
        const last = insertedMessages.at(-1) ?? {}
        return [{ ...last, id: 'chat_msg_new', createdAt: new Date() }]
      }
      return []
    })
    return c
  }

  const tx = {
    insert: (table: { __name?: string }) => chain(table?.__name ?? 'unknown'),
    update: (table: { __name?: string }) => chain(table?.__name ?? 'unknown'),
  }

  return {
    db: {
      select: vi.fn(() => chain('select')),
      insert: vi.fn((table: { __name?: string }) => chain(table?.__name ?? 'unknown')),
      update: vi.fn((table: { __name?: string }) => chain(table?.__name ?? 'unknown')),
      transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    },
    eq: vi.fn(),
    conversations: { __name: 'conversations', id: 'id' },
    chatMessages: { __name: 'chat_messages', id: 'id', isInternal: 'is_internal' },
  }
})

import { addAgentNote } from '../chat.service'

const conversationId = 'conversation_1' as ConversationId
const agent = {
  principalId: 'principal_agent' as PrincipalId,
  displayName: 'Jane',
  avatarUrl: null,
}
const agentActor: Actor = {
  principalId: 'principal_agent' as PrincipalId,
  role: 'admin',
  principalType: 'user',
  segmentIds: new Set(),
}
const visitorActor: Actor = {
  principalId: 'principal_visitor' as PrincipalId,
  role: 'user',
  principalType: 'anonymous',
  segmentIds: new Set(),
}

beforeEach(() => {
  insertedMessages.length = 0
  vi.clearAllMocks()
})

describe('addAgentNote', () => {
  it('writes an internal, agent-typed message', async () => {
    await addAgentNote(conversationId, 'check the logs', agent, agentActor)
    expect(insertedMessages).toHaveLength(1)
    expect(insertedMessages[0]).toMatchObject({
      conversationId,
      principalId: agent.principalId,
      senderType: 'agent',
      isInternal: true,
      content: 'check the logs',
    })
  })

  it('publishes ONLY to the agent inbox, never the visitor conversation channel', async () => {
    await addAgentNote(conversationId, 'internal', agent, agentActor)
    expect(publishAgentChatEvent).toHaveBeenCalledTimes(1)
    // The visitor's conversation channel must never receive an internal note.
    expect(publishChatEvent).not.toHaveBeenCalled()
  })

  it('notifies mentioned teammates', async () => {
    await addAgentNote(conversationId, 'ping @jane.doe', agent, agentActor)
    expect(notifyNoteMentions).toHaveBeenCalledTimes(1)
  })

  it('refuses a non-agent actor before any write', async () => {
    await expect(
      addAgentNote(conversationId, 'sneaky', agent, visitorActor)
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(insertedMessages).toHaveLength(0)
    expect(publishAgentChatEvent).not.toHaveBeenCalled()
  })

  it('rejects empty content before any write', async () => {
    await expect(addAgentNote(conversationId, '   ', agent, agentActor)).rejects.toBeInstanceOf(
      ValidationError
    )
    expect(insertedMessages).toHaveLength(0)
  })
})
