/**
 * resolveSessionRole: the one rule every session-based authority decision
 * uses (requireAuth, the admin route guard, the SSR bootstrap, widget
 * sessions, uploads and MCP OAuth tokens).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  providers: [] as string[],
  applied: null as null | { newRole: string },
  applyError: null as null | Error,
  applyCalls: [] as Array<Record<string, unknown>>,
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      account: {
        findMany: async () => hoisted.providers.map((providerId) => ({ providerId })),
      },
    },
  },
  account: { userId: 'account.userId' },
  user: { id: 'user.id' },
  eq: () => ({}),
}))

vi.mock('../team-designation', () => ({
  applyTeamDesignation: async (input: Record<string, unknown>) => {
    hoisted.applyCalls.push(input)
    if (hoisted.applyError) throw hoisted.applyError
    return hoisted.applied
  },
}))

vi.mock('@/lib/server/logger', () => ({
  logger: {
    child: () => ({ warn: hoisted.warn, error: hoisted.error, info: vi.fn(), debug: vi.fn() }),
  },
}))

const { resolveSessionRole } = await import('../session-role')
const { _resetTeamIdentityLogForTests } = await import('../team-identity')

const savedAdmins = process.env.VENTURI_TEAM_ADMIN_EMAILS

beforeEach(() => {
  hoisted.providers = ['github']
  hoisted.applied = null
  hoisted.applyError = null
  hoisted.applyCalls.length = 0
  hoisted.warn.mockClear()
  hoisted.error.mockClear()
  _resetTeamIdentityLogForTests()
  process.env.VENTURI_TEAM_ADMIN_EMAILS = 'owner@venturi.systems'
})

afterEach(() => {
  if (savedAdmins === undefined) delete process.env.VENTURI_TEAM_ADMIN_EMAILS
  else process.env.VENTURI_TEAM_ADMIN_EMAILS = savedAdmins
})

const record = (role: string, type = 'user') => ({
  id: 'principal_1',
  role,
  type,
  userId: 'user_1',
})
const sessionUser = (email: string, emailVerified = true) => ({
  id: 'user_1',
  email,
  emailVerified,
})

describe('resolveSessionRole', () => {
  it('keeps a team role for a verified team-domain Google or GitHub account', async () => {
    expect(await resolveSessionRole(record('admin'), sessionUser('ops@venturi.systems'))).toBe(
      'admin'
    )
    hoisted.providers = ['google']
    expect(await resolveSessionRole(record('member'), sessionUser('ops@venturi.systems'))).toBe(
      'member'
    )
  })

  it('treats the password bootstrap administrator (credential only, unverified) as a contributor', async () => {
    hoisted.providers = ['credential']
    expect(
      await resolveSessionRole(record('admin'), sessionUser('admin@venturi.systems', false))
    ).toBe('user')
    expect(hoisted.warn).toHaveBeenCalled()
  })

  it('treats a team role on an address outside the team domains as a contributor', async () => {
    expect(await resolveSessionRole(record('admin'), sessionUser('someone@gmail.com'))).toBe('user')
  })

  it('caps a team role on an anonymous or service principal', async () => {
    expect(
      await resolveSessionRole(record('admin', 'anonymous'), sessionUser('ops@venturi.systems'))
    ).toBe('user')
    expect(
      await resolveSessionRole(record('member', 'service'), sessionUser('ops@venturi.systems'))
    ).toBe('user')
    expect(hoisted.applyCalls).toEqual([])
  })

  it('promotes a designated address on the next authenticated request of an existing session', async () => {
    hoisted.applied = { newRole: 'admin' }
    expect(await resolveSessionRole(record('user'), sessionUser('owner@venturi.systems'))).toBe(
      'admin'
    )
    expect(hoisted.applyCalls).toEqual([
      expect.objectContaining({
        userId: 'user_1',
        email: 'owner@venturi.systems',
        emailVerified: true,
        includeInvitations: false,
        source: 'session',
      }),
    ])
  })

  it('does not attempt designation for an address that is not designated', async () => {
    expect(await resolveSessionRole(record('user'), sessionUser('ops@venturi.systems'))).toBe(
      'user'
    )
    expect(hoisted.applyCalls).toEqual([])
  })

  it('does not re-run designation for a designated address that is already admin', async () => {
    expect(await resolveSessionRole(record('admin'), sessionUser('owner@venturi.systems'))).toBe(
      'admin'
    )
    expect(hoisted.applyCalls).toEqual([])
  })

  it('still applies the identity rule when designation declined (identity fails)', async () => {
    hoisted.providers = ['credential']
    expect(await resolveSessionRole(record('user'), sessionUser('owner@venturi.systems'))).toBe(
      'user'
    )
  })

  it('logs a designation failure and answers with the stored role', async () => {
    hoisted.applyError = new Error('database down')
    expect(await resolveSessionRole(record('member'), sessionUser('owner@venturi.systems'))).toBe(
      'member'
    )
    expect(hoisted.error).toHaveBeenCalled()
  })
})
