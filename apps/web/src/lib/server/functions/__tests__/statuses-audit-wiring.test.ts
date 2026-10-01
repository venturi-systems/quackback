/**
 * Audit coverage for status-definition changes made in the admin UI
 * (landing-page#2309, ledger DEF-80). Each mutation in functions/statuses.ts
 * writes exactly one audit row with its event, its target and the definition
 * before and after the change, and a mutation that fails writes none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  recordAuditSafely: vi.fn(),
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
  statuses: {
    listStatuses: vi.fn(),
    getStatusById: vi.fn(),
    createStatus: vi.fn(),
    updateStatus: vi.fn(),
    deleteStatus: vi.fn(),
    reorderStatuses: vi.fn(),
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
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Unit tests must not open a database')
  },
}))
// statusSnapshot reads the stored definition for the before-value of a row.
vi.mock('@/lib/server/db', () => ({
  db: { query: { postStatuses: { findFirst: hoisted.findFirst } } },
  postStatuses: { id: 'post_statuses.id' },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
}))
vi.mock('@/lib/server/audit/audit-safe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/audit/audit-safe')>()),
  recordAuditSafely: hoisted.recordAuditSafely,
}))
vi.mock('@/lib/server/domains/statuses/status.service', () => hoisted.statuses)

import * as statusFns from '../statuses'

type Handler = (args: { data: Record<string, unknown> }) => Promise<unknown>
const call = (fn: unknown, data: Record<string, unknown>) => (fn as Handler)({ data })

function rows() {
  return hoisted.recordAuditSafely.mock.calls.map(([input]) => input as Record<string, unknown>)
}

/** What the real sessionAuditActor makes of the session mocked below. */
const ACTOR = {
  userId: 'user_1',
  email: 'member@example.com',
  role: 'member',
  type: 'user',
  authMethod: 'session',
}

const STORED = {
  id: 'status_1',
  name: 'Open',
  slug: 'open',
  color: '#2563eb',
  category: 'active',
  position: 0,
  showOnRoadmap: true,
  isDefault: true,
}
const STORED_VIEW = {
  name: 'Open',
  slug: 'open',
  color: '#2563eb',
  category: 'active',
  showOnRoadmap: true,
  isDefault: true,
}
const UPDATED = { ...STORED, name: 'Triage', color: '#7c3aed' }
const UPDATED_VIEW = { ...STORED_VIEW, name: 'Triage', color: '#7c3aed' }

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue({
    user: { id: 'user_1', email: 'member@example.com', name: 'Member' },
    principal: { id: 'principal_1', role: 'member', type: 'user' },
  })
  hoisted.findFirst.mockResolvedValue(STORED)
  hoisted.statuses.createStatus.mockResolvedValue(STORED)
  hoisted.statuses.updateStatus.mockResolvedValue(UPDATED)
  hoisted.statuses.deleteStatus.mockResolvedValue(undefined)
  hoisted.statuses.reorderStatuses.mockResolvedValue(undefined)
})

describe('status definition changes write exactly one audit row each (DEF-80)', () => {
  it.each([
    {
      name: 'createStatusFn',
      event: 'status.created',
      data: { name: 'Open', slug: 'open', color: '#2563eb', category: 'active' },
      row: { target: { type: 'status', id: 'status_1' }, after: STORED_VIEW },
    },
    {
      name: 'updateStatusFn',
      event: 'status.updated',
      data: { id: 'status_1', name: 'Triage', color: '#7c3aed' },
      row: {
        target: { type: 'status', id: 'status_1' },
        before: STORED_VIEW,
        after: UPDATED_VIEW,
      },
    },
    {
      name: 'deleteStatusFn',
      event: 'status.deleted',
      data: { id: 'status_1' },
      row: { target: { type: 'status', id: 'status_1' }, before: STORED_VIEW },
    },
    {
      name: 'reorderStatusesFn',
      event: 'status.reordered',
      data: { statusIds: ['status_2', 'status_1'] },
      row: { target: { type: 'status' }, after: { order: ['status_2', 'status_1'] } },
    },
  ])('$name records one $event row', async ({ name, event, data, row }) => {
    await call(statusFns[name as keyof typeof statusFns], data)
    expect(rows()).toEqual([{ event, actor: ACTOR, ...row }])
    expect(hoisted.recordAuditSafely).toHaveBeenCalledWith(expect.anything(), 'request')
  })

  it.each(['updateStatusFn', 'deleteStatusFn'] as const)(
    '%s reads the stored definition by id for the before-value',
    async (name) => {
      await call(statusFns[name], { id: 'status_1', name: 'Triage' })
      expect(hoisted.findFirst).toHaveBeenCalledWith({
        where: { column: 'post_statuses.id', value: 'status_1' },
      })
    }
  )

  it.each([
    {
      name: 'createStatusFn',
      service: 'createStatus',
      data: { name: 'Open', slug: 'open', color: '#2563eb', category: 'active' },
    },
    { name: 'updateStatusFn', service: 'updateStatus', data: { id: 'status_1', name: 'Triage' } },
    { name: 'deleteStatusFn', service: 'deleteStatus', data: { id: 'status_1' } },
    { name: 'reorderStatusesFn', service: 'reorderStatuses', data: { statusIds: ['status_1'] } },
  ])('$name records no row when the change itself fails', async ({ name, service, data }) => {
    hoisted.statuses[service as keyof typeof hoisted.statuses].mockRejectedValue(
      new Error('write failed')
    )
    await expect(call(statusFns[name as keyof typeof statusFns], data)).rejects.toThrow(
      'write failed'
    )
    expect(rows()).toEqual([])
  })

  it('still records an update when the definition before it cannot be read', async () => {
    hoisted.findFirst.mockRejectedValue(new Error('read failed'))
    await call(statusFns.updateStatusFn, { id: 'status_1', name: 'Triage' })
    expect(rows()).toEqual([
      expect.objectContaining({ event: 'status.updated', before: null, after: UPDATED_VIEW }),
    ])
  })

  it('checks the caller before reading or changing anything', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(call(statusFns.deleteStatusFn, { id: 'status_1' })).rejects.toThrow(
      'Access denied'
    )
    expect(hoisted.findFirst).not.toHaveBeenCalled()
    expect(hoisted.statuses.deleteStatus).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
  })
})
