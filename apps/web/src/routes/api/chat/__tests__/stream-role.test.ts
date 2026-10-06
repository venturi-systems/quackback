/**
 * GET /api/chat/stream must authorize with the role the caller may EXERCISE,
 * not the stored one. A stored team role on an identity that fails the team
 * identity rule (for example a password-only bootstrap administrator with a
 * live session) acts as a contributor everywhere else; before this fix the
 * stream read `principal.role` raw, so such an account still got the team
 * inbox and could view any conversation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockPrincipalFindFirst = vi.fn()
const mockConversationFindFirst = vi.fn()
const mockGetSession = vi.fn()
const mockVerifyStreamToken = vi.fn()
const mockResolveSessionRole = vi.fn()
const mockResolveTeamRole = vi.fn()
const mockCanViewConversation = vi.fn()
const mockResolvePortalAccess = vi.fn()
const mockSubscribe = vi.fn()
const mockUnsubscribe = vi.fn()
const mockMarkPresent = vi.fn()
const mockRefreshPresence = vi.fn()
const mockClearPresence = vi.fn()
const mockFindBackfillCursor = vi.fn()
const mockLoadAuthors = vi.fn()
const mockBackfillRows = vi.fn()

const admission = vi.hoisted(() => ({ assert: vi.fn(async () => undefined) }))
vi.mock('@/lib/server/auth/portal-admission', () => ({
  assertPortalSessionAdmission: admission.assert,
  assertPortalContentAdmission: admission.assert,
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      principal: { findFirst: (...a: unknown[]) => mockPrincipalFindFirst(...a) },
      conversations: { findFirst: (...a: unknown[]) => mockConversationFindFirst(...a) },
    },
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: (...a: unknown[]) => mockBackfillRows(...a) }),
      }),
    }),
  },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  gt: vi.fn(),
  isNull: vi.fn(),
  conversations: { id: 'id' },
  chatMessages: {},
  principal: { id: 'id', userId: 'user_id' },
}))
vi.mock('@/lib/server/auth', () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}))
vi.mock('@/lib/server/realtime/stream-token', () => ({
  verifyStreamToken: (...a: unknown[]) => mockVerifyStreamToken(...a),
}))
vi.mock('@/lib/server/realtime/chat-channels', () => ({
  conversationChannel: (id: string) => `chat:${id}`,
  CHAT_INBOX_CHANNEL: 'chat:inbox',
  parseChatFrame: (message: string) => JSON.parse(message),
  isOwnTyping: () => false,
}))
vi.mock('@/lib/server/realtime/pubsub', () => ({
  subscribe: (...a: unknown[]) => mockSubscribe(...a),
}))
vi.mock('@/lib/server/realtime/presence', () => ({
  markPresent: (...a: unknown[]) => mockMarkPresent(...a),
  refreshPresence: (...a: unknown[]) => mockRefreshPresence(...a),
  clearPresence: (...a: unknown[]) => mockClearPresence(...a),
}))
vi.mock('@/lib/server/policy/chat', () => ({
  canViewConversation: (...a: unknown[]) => mockCanViewConversation(...a),
}))
vi.mock('@/lib/server/domains/chat/chat.query', () => ({
  loadAuthors: (...a: unknown[]) => mockLoadAuthors(...a),
  toMessageDTO: (message: unknown) => message,
  fallbackAuthor: vi.fn(),
  findBackfillCursor: (...a: unknown[]) => mockFindBackfillCursor(...a),
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({
  normalizePrincipalType: (type: string) => type,
}))
vi.mock('@/lib/server/domains/principals/session-role', () => ({
  resolveSessionRole: (...a: unknown[]) => mockResolveSessionRole(...a),
}))
vi.mock('@/lib/server/domains/principals/team-identity', () => ({
  resolveTeamRole: (...a: unknown[]) => mockResolveTeamRole(...a),
}))
vi.mock('@/lib/server/domains/settings/settings.support', () => ({
  isConversationsEnabled: vi.fn(async () => true),
}))
vi.mock('@/lib/server/functions/portal-access', () => ({
  resolvePortalAccessForRequest: (...a: unknown[]) => mockResolvePortalAccess(...a),
}))

type Handler = (ctx: { request: Request }) => Promise<Response>

async function getHandler(): Promise<Handler> {
  const mod = await import('../stream')
  return (mod.Route.options as unknown as { server: { handlers: { GET: Handler } } }).server
    .handlers.GET
}

/** A request whose client already went away, so an opened stream tears down at once. */
function streamRequest(query: string): Request {
  const controller = new AbortController()
  controller.abort()
  return new Request(`http://test/api/chat/stream?${query}`, { signal: controller.signal })
}

const bootstrapAdmin = {
  id: 'principal_boot',
  userId: 'user_boot',
  role: 'admin',
  type: 'user',
}
const sessionUser = { id: 'user_boot', email: 'boot@venturi.systems', emailVerified: false }

beforeEach(() => {
  vi.clearAllMocks()
  admission.assert.mockResolvedValue(undefined)
  mockSubscribe.mockImplementation(async () => mockUnsubscribe)
  mockUnsubscribe.mockResolvedValue(undefined)
  mockMarkPresent.mockResolvedValue(undefined)
  mockRefreshPresence.mockResolvedValue(undefined)
  mockClearPresence.mockResolvedValue(false)
  mockFindBackfillCursor.mockResolvedValue(null)
  mockLoadAuthors.mockResolvedValue(new Map())
  mockBackfillRows.mockResolvedValue([])
  mockResolveTeamRole.mockImplementation((row) => mockResolveSessionRole(row))
  mockVerifyStreamToken.mockReturnValue(null)
  mockGetSession.mockResolvedValue({ user: sessionUser })
  mockPrincipalFindFirst.mockResolvedValue(bootstrapAdmin)
  mockResolvePortalAccess.mockResolvedValue({ granted: true, reason: 'authenticated' })
  mockCanViewConversation.mockReturnValue({ allowed: false })
})

describe('GET /api/chat/stream — exercised role', () => {
  it('refuses the team inbox to a stored admin whose identity fails the rule', async () => {
    mockResolveSessionRole.mockResolvedValue('user')
    const handler = await getHandler()

    const res = await handler({ request: streamRequest('scope=inbox') })

    expect(res.status).toBe(403)
    expect(mockResolveSessionRole).toHaveBeenCalledWith(
      bootstrapAdmin,
      sessionUser,
      expect.anything()
    )
  })

  it('refuses agent presence to the same account', async () => {
    mockResolveSessionRole.mockResolvedValue('user')
    const handler = await getHandler()

    const res = await handler({ request: streamRequest('scope=presence') })

    expect(res.status).toBe(403)
  })

  it('opens the inbox for an administrator who satisfies the rule', async () => {
    mockResolveSessionRole.mockResolvedValue('admin')
    const handler = await getHandler()

    const res = await handler({ request: streamRequest('scope=inbox') })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    // Release the stream even if the runtime ignored the pre-aborted signal.
    await res.body?.cancel().catch(() => undefined)
  })

  it('passes the exercised role, not the stored one, to the conversation policy', async () => {
    mockResolveSessionRole.mockResolvedValue('user')
    mockConversationFindFirst.mockResolvedValue({ id: 'conversation_1' })
    const handler = await getHandler()

    const res = await handler({ request: streamRequest('conversationId=conversation_1') })

    expect(res.status).toBe(404)
    // A contributor goes through the portal gate that team members skip.
    expect(mockResolvePortalAccess).toHaveBeenCalledOnce()
    const actor = mockCanViewConversation.mock.calls[0][0] as { role: string }
    expect(actor.role).toBe('user')
  })

  it('resolves a stream-token principal through the team identity rule', async () => {
    mockVerifyStreamToken.mockReturnValue('principal_boot')
    mockResolveTeamRole.mockResolvedValue('user')
    const handler = await getHandler()

    const res = await handler({ request: streamRequest('scope=inbox&token=t') })

    expect(res.status).toBe(403)
    expect(mockResolveTeamRole).toHaveBeenCalledWith(bootstrapAdmin)
    expect(mockGetSession).not.toHaveBeenCalled()
  })
})

describe('GET /api/chat/stream — current admission', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mockVerifyStreamToken.mockReturnValue('principal_boot')
    mockResolveSessionRole.mockResolvedValue('user')
    mockConversationFindFirst.mockResolvedValue({ id: 'conversation_1' })
    mockCanViewConversation.mockReturnValue({ allowed: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function openStream(lastEventId?: string): Promise<Response> {
    const handler = await getHandler()
    return handler({
      request: new Request('http://test/api/chat/stream?conversationId=conversation_1&token=t', {
        headers: lastEventId ? { 'last-event-id': lastEventId } : undefined,
      }),
    })
  }

  function publishMessage(id: string): void {
    const onMessage = mockSubscribe.mock.calls[0][1] as (channel: string, message: string) => void
    onMessage(
      'chat:conversation_1',
      JSON.stringify({ kind: 'message', message: { id, body: 'Private conversation content' } })
    )
  }

  async function expectClosed(response: Response): Promise<string> {
    await vi.waitFor(() => expect(mockClearPresence).toHaveBeenCalledOnce())
    const body = await response.text()
    expect(mockUnsubscribe).toHaveBeenCalledOnce()
    expect(mockRefreshPresence).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    return body
  }

  it('refuses an issued stream token after admission is revoked, before subscribing', async () => {
    admission.assert.mockRejectedValueOnce(new Error('Admission revoked'))

    const response = await openStream()

    expect(response.status).toBe(403)
    expect(admission.assert).toHaveBeenCalledWith('user_boot')
    expect(mockConversationFindFirst).not.toHaveBeenCalled()
    expect(mockSubscribe).not.toHaveBeenCalled()
    expect(mockMarkPresent).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['approval', 'role', 'principal type', 'linked user'] as const)(
    'closes an open stream when its %s changes before the next live event',
    async (changed) => {
      const response = await openStream()
      try {
        expect(response.status).toBe(200)
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
        if (changed === 'approval') {
          admission.assert.mockRejectedValue(new Error('Admission revoked'))
        } else if (changed === 'role') {
          mockResolveTeamRole.mockResolvedValue('member')
        } else if (changed === 'principal type') {
          mockPrincipalFindFirst.mockResolvedValue({ ...bootstrapAdmin, type: 'service' })
        } else {
          mockPrincipalFindFirst.mockResolvedValue({ ...bootstrapAdmin, userId: 'user_relinked' })
        }

        publishMessage('message_revoked')

        const body = await expectClosed(response)
        expect(body).not.toContain('message_revoked')
        expect(body).not.toContain('Private conversation content')
        expect(admission.assert).toHaveBeenCalledTimes(2)
      } finally {
        await response.body?.cancel().catch(() => undefined)
      }
    }
  )

  it('closes an idle revoked stream on heartbeat without refreshing presence', async () => {
    const response = await openStream()
    try {
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
      admission.assert.mockRejectedValue(new Error('Admission revoked'))

      await vi.advanceTimersByTimeAsync(20_000)

      const body = await expectClosed(response)
      expect(body).not.toContain(': ping')
    } finally {
      await response.body?.cancel().catch(() => undefined)
    }
  })

  it('does not allocate a heartbeat after revocation closes a reconnect during backfill', async () => {
    mockFindBackfillCursor.mockResolvedValue({ id: 'message_before', createdAt: new Date(0) })
    mockBackfillRows.mockResolvedValue([
      {
        id: 'message_backfill',
        conversationId: 'conversation_1',
        principalId: 'principal_boot',
        body: 'Private missed message',
      },
    ])
    mockLoadAuthors.mockImplementation(async () => {
      admission.assert.mockRejectedValue(new Error('Admission revoked during backfill'))
      return new Map()
    })
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    const response = await openStream('message_before')
    try {
      const body = await expectClosed(response)
      expect(body).not.toContain('message_backfill')
      expect(body).not.toContain('Private missed message')
      expect(mockBackfillRows).toHaveBeenCalledOnce()
      expect(setIntervalSpy).not.toHaveBeenCalled()
    } finally {
      setIntervalSpy.mockRestore()
      await response.body?.cancel().catch(() => undefined)
    }
  })

  it('delivers an approved frame and suppresses the next frame after revocation', async () => {
    const response = await openStream()
    const reader = response.body!.getReader()
    try {
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
      // Consume the retry hint and connection comment before inspecting data.
      await reader.read()
      await reader.read()
      publishMessage('message_approved')

      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('message_approved')
      admission.assert.mockRejectedValue(new Error('Admission revoked'))
      publishMessage('message_revoked')

      expect((await reader.read()).done).toBe(true)
      expect(mockUnsubscribe).toHaveBeenCalledOnce()
      expect(mockClearPresence).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  })
})
