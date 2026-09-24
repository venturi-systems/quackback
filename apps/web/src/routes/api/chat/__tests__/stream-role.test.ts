/**
 * GET /api/chat/stream must authorize with the role the caller may EXERCISE,
 * not the stored one. A stored team role on an identity that fails the team
 * identity rule (for example a password-only bootstrap administrator with a
 * live session) acts as a contributor everywhere else; before this fix the
 * stream read `principal.role` raw, so such an account still got the team
 * inbox and could view any conversation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrincipalFindFirst = vi.fn()
const mockConversationFindFirst = vi.fn()
const mockGetSession = vi.fn()
const mockVerifyStreamToken = vi.fn()
const mockResolveSessionRole = vi.fn()
const mockResolveTeamRole = vi.fn()
const mockCanViewConversation = vi.fn()
const mockResolvePortalAccess = vi.fn()

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      principal: { findFirst: (...a: unknown[]) => mockPrincipalFindFirst(...a) },
      conversations: { findFirst: (...a: unknown[]) => mockConversationFindFirst(...a) },
    },
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
  parseChatFrame: () => null,
  isOwnTyping: () => false,
}))
vi.mock('@/lib/server/realtime/pubsub', () => ({
  subscribe: vi.fn(async () => async () => undefined),
}))
vi.mock('@/lib/server/realtime/presence', () => ({
  markPresent: vi.fn(async () => undefined),
  refreshPresence: vi.fn(async () => undefined),
  clearPresence: vi.fn(async () => false),
}))
vi.mock('@/lib/server/policy/chat', () => ({
  canViewConversation: (...a: unknown[]) => mockCanViewConversation(...a),
}))
vi.mock('@/lib/server/domains/chat/chat.query', () => ({
  loadAuthors: vi.fn(),
  toMessageDTO: vi.fn(),
  fallbackAuthor: vi.fn(),
  findBackfillCursor: vi.fn(),
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
