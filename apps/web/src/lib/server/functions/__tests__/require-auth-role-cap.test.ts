/**
 * requireAuth / getOptionalAuth only let a HUMAN principal exercise a team
 * role. An anonymous (or service) principal that carries `admin`/`member` is
 * treated as a portal user, so it fails every team-role check. Such a row can
 * only come from a privilege-escalation path (for example the pre-fix
 * onboarding promotion), so it must never grant team access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string } },
  principal: undefined as undefined | Record<string, unknown>,
  warn: vi.fn(),
}))

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = { validator: () => chain, handler: (fn: unknown) => fn }
    return chain
  },
  createServerOnlyFn: <T>(fn: T) => fn,
}))
vi.mock('@tanstack/react-start/server', () => ({ getRequestHeaders: () => new Headers() }))
vi.mock('@/lib/server/auth', () => ({
  auth: { api: { getSession: async () => hoisted.session } },
}))
vi.mock('@/lib/server/functions/workspace', () => ({
  getSettings: async () => ({ id: 'workspace_1', slug: 'venturi', name: 'Venturi', logoKey: null }),
}))
vi.mock('@/lib/server/db', () => ({
  db: {
    query: { principal: { findFirst: async () => hoisted.principal } },
    insert: vi.fn(),
  },
  principal: { userId: 'userId' },
  eq: vi.fn(),
}))
vi.mock('@/lib/server/domains/segments/segment-membership.service', () => ({
  segmentIdsForPrincipal: vi.fn(async () => new Set()),
}))
vi.mock('@/lib/server/logger', () => ({
  logger: {
    child: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: hoisted.warn }),
  },
}))

const { requireAuth, getOptionalAuth } = await import('../auth-helpers')

function signedIn(role: string, type: string) {
  hoisted.session = { user: { id: 'user_1', email: 'jane@acme.example', name: 'Jane' } }
  hoisted.principal = { id: 'principal_1', userId: 'user_1', role, type }
}

beforeEach(() => {
  hoisted.session = null
  hoisted.principal = undefined
  hoisted.warn.mockClear()
})

describe('requireAuth role cap', () => {
  it('rejects a cookie-less caller', async () => {
    await expect(requireAuth({ roles: ['admin'] })).rejects.toThrow('Authentication required')
  })

  it.each([
    ['admin', 'user', ['admin']],
    ['member', 'user', ['admin', 'member']],
    ['user', 'user', ['admin', 'member', 'user']],
  ] as const)('lets a human %s through %j', async (role, type, roles) => {
    signedIn(role, type)
    const ctx = await requireAuth({ roles: [...roles] })
    expect(ctx.principal.role).toBe(role)
  })

  it.each([
    ['admin', ['admin']],
    ['admin', ['admin', 'member']],
    ['member', ['admin', 'member']],
  ] as const)('rejects an anonymous principal holding %s for %j', async (storedRole, roles) => {
    signedIn(storedRole, 'anonymous')
    await expect(requireAuth({ roles: [...roles] })).rejects.toThrow(
      /Access denied: Requires .*got user/
    )
    expect(hoisted.warn).toHaveBeenCalled()
  })

  it('rejects a service-typed principal holding admin on a session path', async () => {
    signedIn('admin', 'service')
    await expect(requireAuth({ roles: ['admin'] })).rejects.toThrow(/got user/)
  })

  it('treats an anonymous principal holding admin as a portal user where users are allowed', async () => {
    signedIn('admin', 'anonymous')
    const ctx = await requireAuth({ roles: ['admin', 'member', 'user'] })
    expect(ctx.principal.role).toBe('user')
    expect(ctx.principal.type).toBe('anonymous')
  })

  it('rejects a portal user for team roles', async () => {
    signedIn('user', 'user')
    await expect(requireAuth({ roles: ['admin', 'member'] })).rejects.toThrow(/got user/)
  })
})

describe('getOptionalAuth role cap', () => {
  it('returns null without a session', async () => {
    expect(await getOptionalAuth()).toBeNull()
  })

  it('reports the stored role for a human principal', async () => {
    signedIn('member', 'user')
    expect((await getOptionalAuth())?.principal.role).toBe('member')
  })

  it('reports an anonymous principal holding admin as a portal user', async () => {
    signedIn('admin', 'anonymous')
    expect((await getOptionalAuth())?.principal.role).toBe('user')
  })
})
