/**
 * DEF-35 (landing-page#2309): rename-then-change must not bypass the
 * `boards.<slug>.access` policy lock.
 *
 * Before the fix, renaming a policy-owned board (updateBoardFn, open to team
 * members, or REST PATCH /boards/:id) re-derived its slug from the new name.
 * updateBoardAccessFn then checked `boards.<new-slug>.access`, which is not
 * in POLICY_MANAGED_SETTINGS, so an administrator could change the access of
 * a board the policy owns. The feedback reconciler, which identifies its
 * boards by id plus slug, would also have lost the pair. Now a managed
 * board's slug never changes, so the lock keeps applying.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  board: null as null | Record<string, unknown>,
  set: {} as Record<string, unknown>,
}))

vi.mock('@/lib/server/db', async () => {
  const drizzle = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')
  return {
    db: {
      query: {
        boards: {
          findFirst: async ({ where }: { where: unknown }) => {
            // The uniqueness probe for a new slug finds nothing.
            return JSON.stringify(where).includes('"slug"') ? undefined : hoisted.board
          },
        },
      },
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          hoisted.set = patch
          return {
            where: () => ({
              returning: async () => [{ ...hoisted.board, ...patch }],
            }),
          }
        },
      }),
    },
    boards: { id: 'id', slug: 'slug', deletedAt: 'deletedAt' },
    posts: { boardId: 'boardId', deletedAt: 'deletedAt' },
    webhooks: { boardIds: 'boardIds' },
    eq: (col: string, val: unknown) => ({ [col]: val }),
    and: drizzle.and,
    isNull: drizzle.isNull,
    inArray: drizzle.inArray,
    asc: drizzle.asc,
    sql: drizzle.sql,
  }
})
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({ getTierLimits: vi.fn() }))
vi.mock('@/lib/server/domains/settings/tier-enforce', () => ({ enforceCountLimit: vi.fn() }))

const { updateBoard, isBoardAccessPolicyManaged } = await import('../board.service')
const { _internalAssertNotManaged } = await import('@/lib/server/config-file/managed-guard')
const { boardAccessManagedPath } = await import('@/lib/shared/policy-managed-paths')
const { config } = await import('@/lib/server/config')

const BOARD_ID = 'board_01' as never
const board = (slug: string) => ({
  id: BOARD_ID,
  name: 'Feature Requests',
  slug,
  description: null,
  settings: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
})

const saved = process.env.POLICY_MANAGED_SETTINGS

beforeEach(() => {
  process.env.POLICY_MANAGED_SETTINGS = 'boards.feature-requests.access'
  hoisted.board = board('feature-requests')
  hoisted.set = {}
})

afterEach(() => {
  if (saved === undefined) delete process.env.POLICY_MANAGED_SETTINGS
  else process.env.POLICY_MANAGED_SETTINGS = saved
})

describe('policy-managed board slug (DEF-35)', () => {
  it('knows which boards the policy owns', () => {
    expect(isBoardAccessPolicyManaged('feature-requests')).toBe(true)
    expect(isBoardAccessPolicyManaged('bug-reports')).toBe(false)
  })

  it('keeps the slug when a managed board is renamed, so the access lock still applies', async () => {
    const renamed = await updateBoard(BOARD_ID, { name: 'Product Ideas' })
    expect(hoisted.set).toHaveProperty('name', 'Product Ideas')
    expect(hoisted.set).not.toHaveProperty('slug')
    expect(renamed.slug).toBe('feature-requests')

    // The access change that follows is refused against the unchanged slug.
    await expect(
      _internalAssertNotManaged(boardAccessManagedPath(renamed.slug), async () =>
        Promise.resolve(config.policyManagedSettings)
      )
    ).rejects.toMatchObject({ code: 'FIELD_MANAGED' })
  })

  it('refuses an explicit slug change of a managed board', async () => {
    await expect(updateBoard(BOARD_ID, { slug: 'ideas' })).rejects.toMatchObject({
      code: 'FIELD_MANAGED',
    })
    expect(hoisted.set).toEqual({})
  })

  it('still lets an unmanaged board change its slug', async () => {
    hoisted.board = board('bug-reports')
    const renamed = await updateBoard(BOARD_ID, { name: 'Defects' })
    expect(hoisted.set).toHaveProperty('slug', 'defects')
    expect(renamed.slug).toBe('defects')
  })

  it('shows the bypass the fix closes: a changed slug escapes the lock', async () => {
    // What updateBoardAccessFn would have checked after the old rename.
    await expect(
      _internalAssertNotManaged(boardAccessManagedPath('product-ideas'), async () =>
        Promise.resolve(config.policyManagedSettings)
      )
    ).resolves.toBeUndefined()
  })
})
