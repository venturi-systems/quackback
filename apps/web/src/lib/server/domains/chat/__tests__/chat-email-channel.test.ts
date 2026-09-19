import { describe, it, expect } from 'vitest'
import {
  isEmailInboundConfigured,
  inboundReplyToAddress,
  conversationIdFromInboundAddress,
} from '../chat.email-channel'

// 'whsec_' + base64('testsecret') / base64('othersecret').
const ENV = {
  EMAIL_INBOUND_DOMAIN: 'tenaevexeo.resend.app',
  EMAIL_INBOUND_SIGNING_SECRET: 'whsec_dGVzdHNlY3JldA==',
}
const OTHER_ENV = { ...ENV, EMAIL_INBOUND_SIGNING_SECRET: 'whsec_b3RoZXJzZWNyZXQ=' }

describe('isEmailInboundConfigured', () => {
  it('is true only when both the inbound domain and signing secret are set', () => {
    expect(isEmailInboundConfigured({})).toBe(false)
    expect(isEmailInboundConfigured({ EMAIL_INBOUND_DOMAIN: 'x.resend.app' })).toBe(false)
    expect(isEmailInboundConfigured({ EMAIL_INBOUND_SIGNING_SECRET: 'whsec_1' })).toBe(false)
    expect(
      isEmailInboundConfigured({
        EMAIL_INBOUND_DOMAIN: 'x.resend.app',
        EMAIL_INBOUND_SIGNING_SECRET: 'whsec_1',
      })
    ).toBe(true)
  })
})

describe('inboundReplyToAddress', () => {
  it('builds a signed plus-addressed reply address', () => {
    expect(inboundReplyToAddress('conversation_abc', ENV)).toMatch(
      /^reply\+conversation_abc\.[A-Za-z0-9_-]+@tenaevexeo\.resend\.app$/
    )
  })

  it('returns null when the inbound domain or signing secret is missing', () => {
    expect(inboundReplyToAddress('conversation_abc', {})).toBeNull()
    expect(
      inboundReplyToAddress('conversation_abc', { EMAIL_INBOUND_DOMAIN: 'tenaevexeo.resend.app' })
    ).toBeNull()
  })
})

describe('conversationIdFromInboundAddress', () => {
  it('round-trips a signed address back to the conversation id', () => {
    const addr = inboundReplyToAddress('conversation_abc', ENV)!
    expect(conversationIdFromInboundAddress(addr, ENV)).toBe('conversation_abc')
    // Tolerant of a display-name wrapper.
    expect(conversationIdFromInboundAddress(`Support <${addr}>`, ENV)).toBe('conversation_abc')
  })

  it('rejects a tampered conversation id whose signature no longer matches', () => {
    const addr = inboundReplyToAddress('conversation_abc', ENV)!
    const tampered = addr.replace('conversation_abc', 'conversation_evil')
    expect(conversationIdFromInboundAddress(tampered, ENV)).toBeNull()
  })

  it('rejects an unsigned (legacy / forged) plus-address', () => {
    expect(
      conversationIdFromInboundAddress('reply+conversation_abc@tenaevexeo.resend.app', ENV)
    ).toBeNull()
  })

  it('rejects a signature minted with a different secret', () => {
    const addr = inboundReplyToAddress('conversation_abc', ENV)!
    expect(conversationIdFromInboundAddress(addr, OTHER_ENV)).toBeNull()
  })

  it('returns null for a non-plus-addressed recipient', () => {
    expect(conversationIdFromInboundAddress('bob@example.com', ENV)).toBeNull()
    expect(conversationIdFromInboundAddress('support@tenaevexeo.resend.app', ENV)).toBeNull()
  })
})
