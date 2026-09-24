/**
 * Admin > Users must not put a team-domain address on a portal user.
 *
 * An account at a team domain is created only by its owner's Google or GitHub
 * sign-in. A row an administrator creates or edits carries an unverified
 * address, and Better Auth refuses to link that person's own sign-in onto an
 * unverified account, so the row would lock them out of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Input = { data: Record<string, unknown> }

vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    let schema: { parse(value: unknown): Input['data'] } | undefined
    const chain = {
      validator(value: typeof schema) {
        schema = value
        return chain
      },
      handler(fn: (args: Input) => Promise<unknown>) {
        return async ({ data }: Input) => fn({ data: schema ? schema.parse(data) : data })
      },
    }
    return chain
  },
}))

const { requireAuth, mockDb, mockSelectLimit, mockInsertValues, mockUpdateSet } = vi.hoisted(() => {
  const mockSelectLimit = vi.fn()
  const mockInsertValues = vi.fn()
  const mockUpdateSet = vi.fn()
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: (...args: unknown[]) => mockSelectLimit(...args),
  }
  const mockDb = {
    query: {
      principal: { findFirst: vi.fn() },
      user: { findFirst: vi.fn() },
    },
    select: () => selectChain,
    insert: () => ({ values: async (...args: unknown[]) => mockInsertValues(...args) }),
    update: () => ({
      set: (...args: unknown[]) => {
        mockUpdateSet(...args)
        return { where: async () => undefined }
      },
    }),
  }
  return { requireAuth: vi.fn(), mockDb, mockSelectLimit, mockInsertValues, mockUpdateSet }
})

vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth,
  policyActorFromAuth: vi.fn(),
}))
vi.mock('@/lib/server/domains/notifications/notification.service', () => ({}))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Admin portal-user unit tests must not connect to a database')
  },
}))
vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: mockDb,
}))

import { createPortalUserFn, updatePortalUserFn } from '../admin'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VENTURI_TEAM_EMAIL_DOMAINS', 'venturi.systems')
  requireAuth.mockResolvedValue({})
  mockSelectLimit.mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createPortalUserFn — team-domain addresses', () => {
  it('refuses to create a portal user at a team domain', async () => {
    await expect(
      createPortalUserFn({ data: { name: 'New Hire', email: 'NewHire@Venturi.Systems' } })
    ).rejects.toMatchObject({ code: 'TEAM_IDENTITY_LOCKED' })
    expect(mockInsertValues).not.toHaveBeenCalled()
  })

  it('still creates the author without an email', async () => {
    await createPortalUserFn({ data: { name: 'New Hire' } })
    const userRow = mockInsertValues.mock.calls[0][0] as { email: unknown }
    expect(userRow.email).toBeNull()
  })

  it('still creates a portal user outside the team domains', async () => {
    await createPortalUserFn({ data: { name: 'Customer', email: 'customer@example.org' } })
    const userRow = mockInsertValues.mock.calls[0][0] as { email: unknown }
    expect(userRow.email).toBe('customer@example.org')
  })
})

describe('updatePortalUserFn — team-domain addresses', () => {
  beforeEach(() => {
    mockDb.query.principal.findFirst.mockResolvedValue({ userId: 'user_1', role: 'user' })
  })

  it('refuses to move a contributor onto a team-domain address', async () => {
    mockDb.query.user.findFirst.mockResolvedValue({ email: 'customer@example.org' })

    await expect(
      updatePortalUserFn({
        data: { principalId: 'principal_1', email: 'newhire@venturi.systems' },
      })
    ).rejects.toMatchObject({ code: 'TEAM_IDENTITY_LOCKED' })
    expect(mockUpdateSet).not.toHaveBeenCalled()
  })

  it('allows a save that keeps the team-domain address the account already has', async () => {
    mockDb.query.user.findFirst.mockResolvedValue({ email: 'teammate@venturi.systems' })

    await updatePortalUserFn({
      data: { principalId: 'principal_1', name: 'Teammate', email: 'teammate@venturi.systems' },
    })

    const userPatch = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>
    expect(userPatch.name).toBe('Teammate')
    // Same address, so its verification is left alone.
    expect(userPatch).not.toHaveProperty('emailVerified')
  })

  it('still lets an administrator change a contributor to another outside address', async () => {
    mockDb.query.user.findFirst.mockResolvedValue({ email: 'old@example.org' })

    await updatePortalUserFn({ data: { principalId: 'principal_1', email: 'new@example.org' } })

    const userPatch = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>
    expect(userPatch.email).toBe('new@example.org')
    expect(userPatch.emailVerified).toBe(false)
  })
})
