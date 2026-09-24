/**
 * CSV import author resolution and team-domain addresses.
 *
 * An account at a team domain is created only by its owner's Google or GitHub
 * sign-in. A CSV row must not create one: Better Auth refuses to link that
 * person's own sign-in onto the unverified row the import would leave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrincipalId } from '@quackback/ids'

const mockLimit = vi.fn()
const mockInsertValues = vi.fn()

vi.mock('@/lib/server/db', () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: (...args: unknown[]) => mockLimit(...args),
  }
  return {
    db: {
      select: () => chain,
      insert: () => ({ values: async (...args: unknown[]) => mockInsertValues(...args) }),
    },
    eq: vi.fn(),
    user: { id: 'id', email: 'email' },
    principal: { id: 'id', userId: 'user_id' },
  }
})

vi.mock('@quackback/ids', () => {
  let counter = 0
  return { createId: vi.fn((prefix: string) => `${prefix}_${++counter}`) }
})

const { ImportUserResolver } = await import('../user-resolver')

const FALLBACK = 'principal_importer' as PrincipalId

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VENTURI_TEAM_EMAIL_DOMAINS', 'venturi.systems')
  mockLimit.mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ImportUserResolver — team-domain addresses', () => {
  it('attributes an unknown team-domain author to the importer and creates nothing', async () => {
    const resolver = new ImportUserResolver()

    const id = await resolver.resolve('NewHire@Venturi.Systems', 'New Hire', FALLBACK)

    expect(id).toBe(FALLBACK)
    expect(resolver.pendingCount).toBe(0)
    expect(await resolver.flushPendingCreates()).toBe(0)
    expect(mockInsertValues).not.toHaveBeenCalled()
  })

  it('still resolves a team-domain author who already has an account', async () => {
    mockLimit.mockResolvedValue([{ principalId: 'principal_teammate' }])
    const resolver = new ImportUserResolver()

    const id = await resolver.resolve('teammate@venturi.systems', 'Teammate', FALLBACK)

    expect(id).toBe('principal_teammate')
    expect(resolver.pendingCount).toBe(0)
  })

  it('still queues an unknown author outside the team domains', async () => {
    const resolver = new ImportUserResolver()

    const id = await resolver.resolve('customer@example.org', 'Customer', FALLBACK)

    expect(id).not.toBe(FALLBACK)
    expect(resolver.pendingCount).toBe(1)
    expect(await resolver.flushPendingCreates()).toBe(1)
    const userRows = mockInsertValues.mock.calls[0][0] as Array<{ email: string }>
    expect(userRows[0].email).toBe('customer@example.org')
  })
})
