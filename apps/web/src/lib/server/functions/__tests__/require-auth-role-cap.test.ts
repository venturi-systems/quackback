/**
 * requireAuth / getOptionalAuth only let a HUMAN principal exercise a team
 * role. An anonymous (or service) principal that carries `admin`/`member` is
 * treated as a portal user, so it fails every team-role check. Such a row can
 * only come from a privilege-escalation path (for example the pre-fix
 * onboarding promotion), so it must never grant team access.
 *
 * A human principal exercises a stored team role only while its identity
 * satisfies the team identity rule (verified team-domain address from a
 * linked Google or GitHub account). A designated address
 * (VENTURI_TEAM_ADMIN_EMAILS) is promoted on the next authenticated request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string; emailVerified?: boolean }
  },
  principal: undefined as undefined | Record<string, unknown>,
  providers: ['github'] as string[],
  designation: vi.fn(),
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
    query: {
      principal: { findFirst: async () => hoisted.principal },
      account: {
        findMany: async () => hoisted.providers.map((providerId) => ({ providerId })),
      },
    },
    insert: vi.fn(),
  },
  principal: { userId: 'userId' },
  account: { userId: 'account.userId' },
  user: { id: 'user.id' },
  eq: vi.fn(),
}))
vi.mock('@/lib/server/domains/principals/team-designation', () => ({
  applyTeamDesignation: (input: unknown) => hoisted.designation(input),
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

function signedIn(role: string, type: string, email = 'jane@acme.example', emailVerified = true) {
  hoisted.session = { user: { id: 'user_1', email, name: 'Jane', emailVerified } }
  hoisted.principal = { id: 'principal_1', userId: 'user_1', role, type }
}

const savedDomains = process.env.VENTURI_TEAM_EMAIL_DOMAINS
const savedAdmins = process.env.VENTURI_TEAM_ADMIN_EMAILS

beforeEach(() => {
  hoisted.session = null
  hoisted.principal = undefined
  hoisted.providers = ['github']
  hoisted.designation.mockReset()
  hoisted.designation.mockResolvedValue(null)
  hoisted.warn.mockClear()
  process.env.VENTURI_TEAM_EMAIL_DOMAINS = 'acme.example'
  delete process.env.VENTURI_TEAM_ADMIN_EMAILS
})

afterEach(() => {
  if (savedDomains === undefined) delete process.env.VENTURI_TEAM_EMAIL_DOMAINS
  else process.env.VENTURI_TEAM_EMAIL_DOMAINS = savedDomains
  if (savedAdmins === undefined) delete process.env.VENTURI_TEAM_ADMIN_EMAILS
  else process.env.VENTURI_TEAM_ADMIN_EMAILS = savedAdmins
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

describe('requireAuth team identity rule', () => {
  it('rejects a stored admin whose only link is the password credential', async () => {
    hoisted.providers = ['credential']
    signedIn('admin', 'user')
    await expect(requireAuth({ roles: ['admin'] })).rejects.toThrow(/got user/)
  })

  it('rejects a stored admin whose address is not verified', async () => {
    signedIn('admin', 'user', 'jane@acme.example', false)
    await expect(requireAuth({ roles: ['admin'] })).rejects.toThrow(/got user/)
  })

  it('rejects a stored member at an address outside the team domains', async () => {
    signedIn('member', 'user', 'jane@gmail.com')
    await expect(requireAuth({ roles: ['admin', 'member'] })).rejects.toThrow(/got user/)
  })

  it('lets a Google-linked team account through', async () => {
    hoisted.providers = ['google', 'credential']
    signedIn('admin', 'user')
    expect((await requireAuth({ roles: ['admin'] })).principal.role).toBe('admin')
  })

  it('promotes a designated address on the next authenticated request', async () => {
    process.env.VENTURI_TEAM_ADMIN_EMAILS = 'jane@acme.example'
    hoisted.designation.mockResolvedValue({ newRole: 'admin' })
    signedIn('user', 'user')
    const ctx = await requireAuth({ roles: ['admin'] })
    expect(ctx.principal.role).toBe('admin')
    expect(hoisted.designation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1', source: 'session', includeInvitations: false })
    )
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
