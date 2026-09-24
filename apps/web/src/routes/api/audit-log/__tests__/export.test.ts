/**
 * GET /api/audit-log/export: administrator-only CSV export of every matching
 * audit row, itself audited (landing-page#2309).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  access: null as null | Record<string, unknown>,
  audits: [] as Array<Record<string, unknown>>,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: unknown) => ({ options: opts }),
}))
vi.mock('@/lib/server/functions/workspace', () => ({
  validateApiWorkspaceAccess: async () => hoisted.access,
}))
vi.mock('@/lib/server/audit/export', () => ({
  AUDIT_EXPORT_COLUMNS: ['id', 'event_type'],
  parseAuditExportFilters: () => ({ eventType: 'board.deleted' }),
  auditRowToCsv: (row: { id: string; eventType: string }) => `"${row.id}","${row.eventType}"`,
  auditExportPages: async function* () {
    yield { rows: [{ id: 'audit_1', eventType: 'board.deleted' }], truncated: false }
  },
}))
vi.mock('@/lib/server/audit/audit-safe', () => ({
  sessionAuditActor: () => ({ email: 'ops@venturi.systems' }),
  recordAuditSafely: async (input: Record<string, unknown>) => {
    hoisted.audits.push(input)
  },
}))

const { handleAuditLogExport } = await import('../export')
const request = () => new Request('https://feedback.example/api/audit-log/export?eventType=x')

beforeEach(() => {
  hoisted.audits.length = 0
})

describe('GET /api/audit-log/export', () => {
  it('refuses a caller without a session', async () => {
    hoisted.access = { success: false, error: 'Unauthorized', status: 401 }
    expect((await handleAuditLogExport({ request: request() })).status).toBe(401)
  })

  it('refuses a team member who is not an administrator', async () => {
    hoisted.access = {
      success: true,
      principal: { role: 'member' },
      user: { id: 'user_1', email: 'm@venturi.systems' },
    }
    expect((await handleAuditLogExport({ request: request() })).status).toBe(403)
  })

  it('streams CSV to an administrator and audits the export', async () => {
    hoisted.access = {
      success: true,
      principal: { role: 'admin', type: 'user' },
      user: { id: 'user_1', email: 'ops@venturi.systems' },
    }
    const res = await handleAuditLogExport({ request: request() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(await res.text()).toBe('id,event_type\n"audit_1","board.deleted"\n')
    await vi.waitFor(() => expect(hoisted.audits).toHaveLength(1))
    expect(hoisted.audits[0]).toMatchObject({
      event: 'audit.exported',
      metadata: expect.objectContaining({ rows: 1, truncated: false }),
    })
  })
})
