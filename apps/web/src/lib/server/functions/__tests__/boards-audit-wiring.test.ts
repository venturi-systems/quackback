/**
 * Audit coverage for board changes made in the admin UI (landing-page#2309,
 * ledger DEF-80). Creating, updating and deleting a board in
 * functions/boards.ts each write exactly one audit row with the event, the
 * target and the board fields before and after the change, and a mutation
 * that fails writes none. The onboarding batch (createBoardsBatchFn) writes
 * one board.created row per board it creates and none for a board it did
 * not (DEF-81). Access changes have their own coverage in
 * update-board-access.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  recordAuditSafely: vi.fn(),
  recordAuditEvent: vi.fn(),
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
  getTierLimits: vi.fn(),
  boards: {
    listBoards: vi.fn(),
    getBoardById: vi.fn(),
    createBoard: vi.fn(),
    updateBoard: vi.fn(),
    deleteBoard: vi.fn(),
  },
}))

vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    const chain = {
      validator() {
        return chain
      },
      handler(fn: unknown) {
        return fn
      },
    }
    return chain
  },
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({ requireAuth: hoisted.requireAuth }))
vi.mock('@/lib/server/functions/workspace', () => ({ getSettings: vi.fn() }))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Unit tests must not open a database')
  },
}))
// boardSnapshot reads the stored board for the before-value of a row.
vi.mock('@/lib/server/db', () => ({
  db: { query: { boards: { findFirst: hoisted.findFirst } } },
  boards: { id: 'boards.id' },
  settings: {},
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  // Real constants from the db re-export; keep in sync with the schema-level enum.
  ACCESS_TIERS: ['anonymous', 'authenticated', 'segments', 'team'] as const,
  ACCESS_TIER_RANK: { anonymous: 0, authenticated: 1, segments: 2, team: 3 } as const,
}))
vi.mock('@/lib/server/domains/boards/board.service', () => hoisted.boards)
vi.mock('@/lib/server/domains/settings/settings.helpers', () => ({
  invalidateSettingsCache: vi.fn(),
}))
// The batch pre-flights the tier cap and picks the boards' default access
// within the deployment's policy; neither may read the environment here.
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: hoisted.getTierLimits,
}))
vi.mock('@/lib/server/config-file/managed-paths', () => ({
  isPathManaged: () => false,
}))
// The path updateBoardAccessFn uses; the create, update and delete rows never use it.
vi.mock('@/lib/server/audit/log', () => ({
  recordAuditEvent: hoisted.recordAuditEvent,
  actorFromAuth: vi.fn(),
}))
vi.mock('@/lib/server/audit/audit-safe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/audit/audit-safe')>()),
  recordAuditSafely: hoisted.recordAuditSafely,
}))

import * as boardFns from '../boards'

type Handler = (args: { data: Record<string, unknown> }) => Promise<unknown>
const call = (fn: unknown, data: Record<string, unknown>) => (fn as Handler)({ data })

function rows() {
  return hoisted.recordAuditSafely.mock.calls.map(([input]) => input as Record<string, unknown>)
}

/** What the real sessionAuditActor makes of the session mocked below. */
const ACTOR = {
  userId: 'user_admin1',
  email: 'admin@example.com',
  role: 'admin',
  type: 'user',
  authMethod: 'session',
}

const BOARD = {
  id: 'board_1',
  name: 'Feature requests',
  slug: 'feature-requests',
  description: 'What should we build next?',
  settings: { roadmapStatusIds: ['status_1'] },
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
}
const BOARD_VIEW = {
  name: 'Feature requests',
  slug: 'feature-requests',
  description: 'What should we build next?',
  settings: { roadmapStatusIds: ['status_1'] },
}
const UPDATED = { ...BOARD, name: 'Feature ideas', description: null }
const UPDATED_VIEW = { ...BOARD_VIEW, name: 'Feature ideas', description: null }

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue({
    user: { id: 'user_admin1', email: 'admin@example.com', name: 'Admin' },
    principal: { id: 'principal_admin1', role: 'admin', type: 'user' },
  })
  hoisted.findFirst.mockResolvedValue(BOARD)
  hoisted.boards.createBoard.mockResolvedValue(BOARD)
  hoisted.boards.updateBoard.mockResolvedValue(UPDATED)
  hoisted.boards.deleteBoard.mockResolvedValue(undefined)
  hoisted.boards.listBoards.mockResolvedValue([])
  hoisted.getTierLimits.mockResolvedValue({ maxBoards: null })
})

describe('board changes write exactly one audit row each (DEF-80)', () => {
  it.each([
    {
      name: 'createBoardFn',
      event: 'board.created',
      roles: ['admin', 'member'],
      data: { name: 'Feature requests', description: BOARD.description, preset: 'public' },
      row: { target: { type: 'board', id: 'board_1' }, after: BOARD_VIEW },
    },
    {
      name: 'updateBoardFn',
      event: 'board.updated',
      roles: ['admin', 'member'],
      data: { id: 'board_1', name: 'Feature ideas', description: null },
      row: { target: { type: 'board', id: 'board_1' }, before: BOARD_VIEW, after: UPDATED_VIEW },
    },
    {
      name: 'deleteBoardFn',
      event: 'board.deleted',
      roles: ['admin'],
      data: { id: 'board_1' },
      row: { target: { type: 'board', id: 'board_1' }, before: BOARD_VIEW },
    },
  ])('$name records one $event row', async ({ name, event, roles, data, row }) => {
    await call(boardFns[name as keyof typeof boardFns], data)
    expect(hoisted.requireAuth).toHaveBeenCalledWith({ roles })
    expect(rows()).toEqual([{ event, actor: ACTOR, ...row }])
    expect(hoisted.recordAuditSafely).toHaveBeenCalledWith(expect.anything(), 'request')
    expect(hoisted.recordAuditEvent).not.toHaveBeenCalled()
  })

  it('records a board with no description or settings as null', async () => {
    hoisted.boards.createBoard.mockResolvedValue({
      ...BOARD,
      description: undefined,
      settings: undefined,
    })
    await call(boardFns.createBoardFn, { name: 'Feature requests', preset: 'private' })
    expect(rows()).toEqual([
      expect.objectContaining({
        event: 'board.created',
        after: { ...BOARD_VIEW, description: null, settings: null },
      }),
    ])
  })

  it.each([
    {
      name: 'createBoardFn',
      service: 'createBoard',
      data: { name: 'Feature requests', preset: 'public' },
    },
    { name: 'updateBoardFn', service: 'updateBoard', data: { id: 'board_1', name: 'Ideas' } },
    { name: 'deleteBoardFn', service: 'deleteBoard', data: { id: 'board_1' } },
  ])('$name records no row when the change itself fails', async ({ name, service, data }) => {
    hoisted.boards[service as keyof typeof hoisted.boards].mockRejectedValue(
      new Error('write failed')
    )
    await expect(call(boardFns[name as keyof typeof boardFns], data)).rejects.toThrow(
      'write failed'
    )
    expect(rows()).toEqual([])
  })

  it('still records an update when the board before it cannot be read', async () => {
    hoisted.findFirst.mockRejectedValue(new Error('read failed'))
    await call(boardFns.updateBoardFn, { id: 'board_1', name: 'Feature ideas' })
    expect(rows()).toEqual([
      expect.objectContaining({ event: 'board.updated', before: null, after: UPDATED_VIEW }),
    ])
  })

  it('checks the administrator role before reading or deleting anything', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(call(boardFns.deleteBoardFn, { id: 'board_1' })).rejects.toThrow('Access denied')
    expect(hoisted.requireAuth).toHaveBeenCalledWith({ roles: ['admin'] })
    expect(hoisted.findFirst).not.toHaveBeenCalled()
    expect(hoisted.boards.deleteBoard).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
  })
})

/** The onboarding wizard's batch: three boards, keyed by name for the mock. */
const BATCH_INPUT = [
  { name: 'Feature requests', description: 'What should we build next?' },
  { name: 'Bugs' },
  { name: 'Ideas', description: 'Blue sky' },
]
type BatchBoard = Omit<typeof BOARD, 'description'> & { description?: string }
const BATCH_BOARDS: Record<string, BatchBoard> = {
  'Feature requests': BOARD,
  Bugs: { ...BOARD, id: 'board_2', name: 'Bugs', slug: 'bugs', description: undefined },
  Ideas: { ...BOARD, id: 'board_3', name: 'Ideas', slug: 'ideas', description: 'Blue sky' },
}
const BATCH_ROWS = [
  {
    event: 'board.created',
    actor: ACTOR,
    target: { type: 'board', id: 'board_1' },
    after: BOARD_VIEW,
  },
  {
    event: 'board.created',
    actor: ACTOR,
    target: { type: 'board', id: 'board_2' },
    after: { ...BOARD_VIEW, name: 'Bugs', slug: 'bugs', description: null },
  },
  {
    event: 'board.created',
    actor: ACTOR,
    target: { type: 'board', id: 'board_3' },
    after: { ...BOARD_VIEW, name: 'Ideas', slug: 'ideas', description: 'Blue sky' },
  },
]

type BatchResult = { boards: Array<{ id: string }>; limited: boolean }
const batch = (boards: unknown[]) =>
  call(boardFns.createBoardsBatchFn, { boards }) as Promise<BatchResult>
/** The header source each row was written with. */
const sources = () => hoisted.recordAuditSafely.mock.calls.map(([, headers]) => headers)

describe('the onboarding batch writes one board.created row per created board (DEF-81)', () => {
  beforeEach(() => {
    hoisted.boards.createBoard.mockImplementation(
      async ({ name }: { name: string }) => BATCH_BOARDS[name]
    )
  })

  it('records a row for each created board, in creation order', async () => {
    const result = await batch(BATCH_INPUT)
    expect(hoisted.requireAuth).toHaveBeenCalledWith({ roles: ['admin', 'member'] })
    expect(hoisted.boards.createBoard).toHaveBeenCalledTimes(3)
    expect(rows()).toEqual(BATCH_ROWS)
    expect(sources()).toEqual(['request', 'request', 'request'])
    expect(hoisted.recordAuditEvent).not.toHaveBeenCalled()
    // The batch's response is unchanged by the audit rows.
    expect(result.boards.map((b) => b.id)).toEqual(['board_1', 'board_2', 'board_3'])
    expect(result.limited).toBe(false)
  })

  it('records no row for a board the tier cap drops', async () => {
    hoisted.getTierLimits.mockResolvedValue({ maxBoards: 2 })
    hoisted.boards.listBoards.mockResolvedValue([{ id: 'board_existing' }])
    const result = await batch(BATCH_INPUT)
    expect(hoisted.boards.createBoard).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual([BATCH_ROWS[0]])
    expect(result.boards.map((b) => b.id)).toEqual(['board_1'])
    expect(result.limited).toBe(true)
  })

  it('records rows only for the boards created before one fails', async () => {
    hoisted.boards.createBoard.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'Bugs') throw new Error('write failed')
      return BATCH_BOARDS[name]
    })
    await expect(batch(BATCH_INPUT)).rejects.toThrow('write failed')
    expect(hoisted.boards.createBoard).toHaveBeenCalledTimes(2)
    expect(rows()).toEqual([BATCH_ROWS[0]])
  })

  it('records nothing for an empty batch (the wizard skip)', async () => {
    const result = await batch([])
    expect(hoisted.boards.createBoard).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
    expect(result).toEqual({ boards: [], limited: false })
  })

  it('checks the role before reading the tier cap or creating anything', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(batch(BATCH_INPUT)).rejects.toThrow('Access denied')
    expect(hoisted.requireAuth).toHaveBeenCalledWith({ roles: ['admin', 'member'] })
    expect(hoisted.getTierLimits).not.toHaveBeenCalled()
    expect(hoisted.boards.createBoard).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
  })
})
