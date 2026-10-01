/**
 * Audit coverage for board changes made in the admin UI (landing-page#2309,
 * ledger DEF-80). Creating, updating and deleting a board in
 * functions/boards.ts each write exactly one audit row with the event, the
 * target and the board fields before and after the change, and a mutation
 * that fails writes none. Access changes have their own coverage in
 * update-board-access.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  recordAuditSafely: vi.fn(),
  recordAuditEvent: vi.fn(),
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
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
