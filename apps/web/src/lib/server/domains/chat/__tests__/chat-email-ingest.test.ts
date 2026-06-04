/**
 * Inbound email ingestion: route a verified `email.received` event into the
 * conversation named by its plus-address, append the visitor's stripped reply
 * via the normal visitor-message path, and treat a redelivered Message-ID as a
 * no-op (idempotency). Drops payloads it can't route rather than throwing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inboundReplyToAddress } from '../chat.email-channel'

// Inbound signing must be configured for the plus-address to verify (the real,
// un-mocked chat.email-channel signs + checks the conversation id).
process.env.EMAIL_INBOUND_DOMAIN = 'tenaevexeo.resend.app'
process.env.EMAIL_INBOUND_SIGNING_SECRET = 'whsec_dGVzdHNlY3JldA=='
const REPLY_TO = inboundReplyToAddress('conversation_abc')!

const sendVisitorMessage = vi.fn()
const assertChatSendRate = vi.fn()
let conversationRow: Record<string, unknown> | undefined
let principalRow: Record<string, unknown> | undefined
let dupeRows: Array<Record<string, unknown>> = []

vi.mock('../chat.service', () => ({
  sendVisitorMessage: (...a: unknown[]) => sendVisitorMessage(...a),
}))

vi.mock('../chat.ratelimit', () => ({
  assertChatSendRate: (...a: unknown[]) => assertChatSendRate(...a),
  ChatRateLimitError: class ChatRateLimitError extends Error {
    readonly code = 'RATE_LIMITED'
    readonly retryAfter = 5
  },
}))

vi.mock('@/lib/server/db', () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => dupeRows,
  }
  return {
    db: {
      query: {
        conversations: { findFirst: async () => conversationRow },
        principal: { findFirst: async () => principalRow },
      },
      select: () => selectChain,
    },
    eq: vi.fn(),
    sql: Object.assign(() => ({}), { raw: () => ({}) }),
    chatMessages: { metadata: 'metadata' },
    conversations: { id: 'id' },
    principal: { id: 'id' },
  }
})

import { ingestInboundEmail } from '../chat.email-inbound.service'

const baseEvent = {
  type: 'email.received',
  data: {
    to: [REPLY_TO],
    from: 'jane@example.com',
    subject: 'Re: ticket',
    text: 'This is my reply.\n\nOn Mon wrote:\n> old',
    headers: [{ name: 'Message-ID', value: '<m-1@x>' }],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  conversationRow = { id: 'conversation_abc', visitorPrincipalId: 'principal_v', status: 'closed' }
  principalRow = { id: 'principal_v', type: 'anonymous', displayName: 'Jane' }
  dupeRows = []
  sendVisitorMessage.mockResolvedValue({ created: false })
  assertChatSendRate.mockResolvedValue(undefined)
})

describe('ingestInboundEmail', () => {
  it('appends the stripped reply as a visitor message into the matched conversation', async () => {
    const result = await ingestInboundEmail(baseEvent)

    expect(result).toEqual({ status: 'ingested', conversationId: 'conversation_abc' })
    expect(sendVisitorMessage).toHaveBeenCalledTimes(1)
    const [input, author, actor] = sendVisitorMessage.mock.calls[0]
    expect(input).toMatchObject({
      conversationId: 'conversation_abc',
      content: 'This is my reply.',
      metadata: { source: 'email', emailMessageId: '<m-1@x>' },
    })
    expect(author).toMatchObject({ principalId: 'principal_v', displayName: 'Jane' })
    expect(actor).toMatchObject({ principalId: 'principal_v', principalType: 'anonymous' })
  })

  it('is a no-op for a redelivered Message-ID (idempotency)', async () => {
    dupeRows = [{ id: 'chat_msg_existing' }]

    const result = await ingestInboundEmail(baseEvent)

    expect(result).toEqual({ status: 'duplicate' })
    expect(sendVisitorMessage).not.toHaveBeenCalled()
  })

  it('drops a payload whose recipients have no plus-address', async () => {
    const result = await ingestInboundEmail({
      type: 'email.received',
      data: { to: ['support@tenaevexeo.resend.app'], text: 'hi' },
    })

    expect(result).toEqual({ status: 'no_conversation' })
    expect(sendVisitorMessage).not.toHaveBeenCalled()
  })

  it('drops when the addressed conversation no longer exists', async () => {
    conversationRow = undefined

    const result = await ingestInboundEmail(baseEvent)

    expect(result).toEqual({ status: 'no_conversation' })
    expect(sendVisitorMessage).not.toHaveBeenCalled()
  })

  it('drops a reply that is empty after stripping quoted history', async () => {
    const result = await ingestInboundEmail({
      type: 'email.received',
      data: {
        to: [REPLY_TO],
        text: 'On Mon wrote:\n> only quoted text',
        headers: [{ name: 'Message-ID', value: '<m-2@x>' }],
      },
    })

    expect(result).toEqual({ status: 'empty' })
    expect(sendVisitorMessage).not.toHaveBeenCalled()
  })

  it('rejects a forged (unsigned / wrong-signature) plus-address', async () => {
    const result = await ingestInboundEmail({
      type: 'email.received',
      data: {
        to: ['reply+conversation_abc@tenaevexeo.resend.app'],
        text: 'injected as the visitor',
        headers: [{ name: 'Message-ID', value: '<m-3@x>' }],
      },
    })

    expect(result).toEqual({ status: 'no_conversation' })
    expect(sendVisitorMessage).not.toHaveBeenCalled()
  })

  it('rate-limits the inbound path (acks without fanning out a message)', async () => {
    const { ChatRateLimitError } = await import('../chat.ratelimit')
    assertChatSendRate.mockRejectedValueOnce(new ChatRateLimitError(5))

    const result = await ingestInboundEmail(baseEvent)

    expect(result).toEqual({ status: 'rate_limited' })
    expect(sendVisitorMessage).not.toHaveBeenCalled()
  })
})
