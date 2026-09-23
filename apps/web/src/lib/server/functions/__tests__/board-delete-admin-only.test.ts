/**
 * Board deletion is administrator-only (issue #2309, audit E-6).
 *
 * Team members keep create and rename (createBoardFn, updateBoardFn), but
 * deleting a board removes all of its posts from the portal, so only an
 * administrator may do it. The REST DELETE route applies the same rule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type AnyHandler = (args: { data: Record<string, unknown> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handlers: [] as AnyHandler[],
  mockRequireAuth: vi.fn(),
  mockUpdateBoard: vi.fn(),
  mockDbUpdate: vi.fn(),
}))

vi.mock('@tanstack/react-start', () => ({
  // workspace.ts getSettings is server-only (createServerOnlyFn).
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    const chain = {
      validator() {
        return chain
      },
      handler(fn: AnyHandler) {
        hoisted.handlers.push(fn)
        return chain
      },
    }
    return chain
  },
}))

vi.mock('./auth-helpers', () => ({
  requireAuth: (...args: unknown[]) => hoisted.mockRequireAuth(...args),
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: (...args: unknown[]) => hoisted.mockRequireAuth(...args),
}))

vi.mock('./workspace', () => ({ getSettings: vi.fn() }))

// --- Board service mock ---
vi.mock('@/lib/server/domains/boards/board.service', () => ({
  listBoards: vi.fn(),
  getBoardById: vi.fn(),
  createBoard: vi.fn(),
  updateBoard: (...args: unknown[]) => hoisted.mockUpdateBoard(...args),
  deleteBoard: vi.fn(),
}))

vi.mock('@/lib/server/domains/settings/settings.helpers', () => ({
  invalidateSettingsCache: vi.fn(),
}))

// --- DB mock: db.update must NOT be called by updateBoardFn ---
vi.mock('@/lib/server/db', () => ({
  db: {
    update: (...args: unknown[]) => hoisted.mockDbUpdate(...args),
    query: {
      boards: { findFirst: vi.fn() },
    },
  },
  settings: {},
  boards: {
    id: { __col: 'id' },
    deletedAt: { __col: 'deletedAt' },
  },
  eq: vi.fn((col: { __col: string }, val: unknown) => ({ kind: 'eq', col: col.__col, val })),
  and: vi.fn((...conds: unknown[]) => ({ kind: 'and', conds })),
  isNull: vi.fn((col: { __col: string }) => ({ kind: 'isNull', col: col.__col })),
  // T15's boardAccessSchema in boards.ts reads these at module-eval time.
  ACCESS_TIERS: ['anonymous', 'authenticated', 'segments', 'team'] as const,
  ACCESS_TIER_RANK: { anonymous: 0, authenticated: 1, segments: 2, team: 3 } as const,
}))

vi.mock('@/lib/shared/roles', () => ({
  isAdmin: vi.fn((role: string) => role === 'admin'),
}))

vi.mock('@/lib/server/audit/log', () => ({
  recordAuditEvent: vi.fn(),
  actorFromAuth: vi.fn(),
}))

// Import after mocks. Handler order in boards.ts (workspace.ts registers
// getCurrentUserRole first): 1=fetchBoardsFn, 2=fetchBoardFn, 3=createBoardFn,
// 4=updateBoardFn, 5=deleteBoardFn.
import * as boardsModule from '../boards'

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.mockRequireAuth.mockReset()
})

describe('board write roles', () => {
  it('deleteBoardFn requires the administrator role', async () => {
    expect(boardsModule).toHaveProperty('deleteBoardFn')
    hoisted.mockRequireAuth.mockResolvedValue({ principal: { role: 'admin' } })
    await hoisted.handlers[5]({ data: { id: 'board_test_1' } })
    expect(hoisted.mockRequireAuth).toHaveBeenCalledWith({ roles: ['admin'] })
  })

  it('deleteBoardFn does not delete when requireAuth refuses a member', async () => {
    const { deleteBoard } = await import('@/lib/server/domains/boards/board.service')
    hoisted.mockRequireAuth.mockRejectedValue(
      new Error('Access denied: Requires [admin], got member')
    )
    await expect(hoisted.handlers[5]({ data: { id: 'board_test_1' } })).rejects.toThrow(
      'Access denied'
    )
    expect(deleteBoard).not.toHaveBeenCalled()
  })

  it('createBoardFn and updateBoardFn stay open to team members', async () => {
    hoisted.mockRequireAuth.mockRejectedValue(new Error('stop after the role check'))
    await expect(
      hoisted.handlers[3]({ data: { name: 'Ideas', preset: 'public' } })
    ).rejects.toThrow()
    await expect(
      hoisted.handlers[4]({ data: { id: 'board_test_1', name: 'Ideas' } })
    ).rejects.toThrow()
    expect(hoisted.mockRequireAuth).toHaveBeenNthCalledWith(1, { roles: ['admin', 'member'] })
    expect(hoisted.mockRequireAuth).toHaveBeenNthCalledWith(2, { roles: ['admin', 'member'] })
  })
})
