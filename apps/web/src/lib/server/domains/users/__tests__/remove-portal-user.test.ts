/**
 * DEF-64 (landing-page#2309): there is never a path to zero administrators.
 *
 * removePortalUser removes contributors only. It used to check the role and
 * then delete by id alone, outside the team-role lock, so a promotion landing
 * between the check and the delete removed a new team member or administrator.
 * The check and the delete now run in the one transaction that holds the
 * team-role advisory lock, the delete repeats the role condition, and a delete
 * that removes no row is refused. The concurrent case runs on PostgreSQL in
 * remove-portal-user-lock-db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrincipalId } from '@quackback/ids'

const hoisted = vi.hoisted(() => {
  const state = {
    principal: undefined as undefined | { id: string },
    /** The rows the conditional delete reports as removed. */
    removed: [] as Array<{ id: string }>,
    lockError: undefined as unknown,
    /** True only while the withTeamRoleLock callback runs. */
    locked: false,
    lockCount: 0,
    /** Every read and write, with whether it ran under the lock and on which executor. */
    calls: [] as Array<{ op: string; locked: boolean; tx: unknown; where?: unknown }>,
    tx: undefined as unknown,
  }
  const tx = {
    query: {
      principal: {
        findFirst: async (args: { where: unknown }) => {
          state.calls.push({ op: 'principal.findFirst', locked: state.locked, tx, ...args })
          return state.principal
        },
      },
    },
    delete: () => ({
      where: (where: unknown) => ({
        returning: async () => {
          state.calls.push({ op: 'principal.delete', locked: state.locked, tx, where })
          return state.removed
        },
      }),
    }),
  }
  state.tx = tx
  return state
})

vi.mock('@/lib/server/domains/principals/team-designation', () => ({
  withTeamRoleLock: async <T>(fn: (tx: unknown) => Promise<T>) => {
    if (hoisted.lockError) throw hoisted.lockError
    hoisted.lockCount += 1
    hoisted.locked = true
    try {
      return await fn(hoisted.tx)
    } finally {
      hoisted.locked = false
    }
  },
}))

// Conditions become plain data, so a test can read the where clause it built.
vi.mock('@/lib/server/db', () => ({
  // Nothing may reach the pooled connection: every step runs on the lock's tx.
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('removePortalUser must not use the pooled connection')
      },
    }
  ),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
  and: (...conds: unknown[]) => ({ and: conds }),
  or: vi.fn(),
  ilike: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
  sql: vi.fn(),
  principal: { id: 'principal.id', role: 'principal.role' },
  user: {},
  posts: {},
  comments: {},
  votes: {},
  userSegments: {},
  segments: {},
}))

const { removePortalUser } = await import('../user.service')

const PRINCIPAL_ID = 'principal_carol' as PrincipalId
const contributorOnly = {
  and: [{ eq: ['principal.id', PRINCIPAL_ID] }, { eq: ['principal.role', 'user'] }],
}

beforeEach(() => {
  hoisted.principal = { id: PRINCIPAL_ID }
  hoisted.removed = [{ id: PRINCIPAL_ID }]
  hoisted.lockError = undefined
  hoisted.locked = false
  hoisted.lockCount = 0
  hoisted.calls = []
})

describe('removePortalUser', () => {
  it('checks and deletes a contributor in the one transaction that holds the lock', async () => {
    await expect(removePortalUser(PRINCIPAL_ID)).resolves.toBeUndefined()

    expect(hoisted.lockCount).toBe(1)
    expect(hoisted.calls.map((c) => c.op)).toEqual(['principal.findFirst', 'principal.delete'])
    for (const call of hoisted.calls) {
      expect(call).toMatchObject({ locked: true, tx: hoisted.tx, where: contributorOnly })
    }
  })

  it('refuses a principal that is not a contributor, and deletes nothing', async () => {
    hoisted.principal = undefined
    await expect(removePortalUser(PRINCIPAL_ID)).rejects.toMatchObject({
      code: 'MEMBER_NOT_FOUND',
      statusCode: 404,
    })
    expect(hoisted.calls.map((c) => c.op)).toEqual(['principal.findFirst'])
  })

  it('refuses when the role changed before the delete, so no row was removed', async () => {
    // The read saw a contributor; the conditional delete found a team role.
    hoisted.removed = []
    await expect(removePortalUser(PRINCIPAL_ID)).rejects.toMatchObject({
      code: 'MEMBER_NOT_FOUND',
      statusCode: 404,
    })
    expect(hoisted.calls.map((c) => c.op)).toEqual(['principal.findFirst', 'principal.delete'])
  })

  it('reports a database failure as an internal error, not as success', async () => {
    hoisted.lockError = new Error('connection terminated')
    await expect(removePortalUser(PRINCIPAL_ID)).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
      statusCode: 500,
    })
    expect(hoisted.calls).toEqual([])
  })
})
