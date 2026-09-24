/**
 * Server-side audit-log export (landing-page#2309): keyset paging over every
 * matching row, every column including before and after values, formula-safe
 * CSV, and filters parsed from the query string.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  pages: [] as Array<Array<Record<string, unknown>>>,
  queries: [] as Array<{ where: unknown; limit: number }>,
}))

vi.mock('@/lib/server/db', () => {
  const op =
    (name: string) =>
    (...args: unknown[]) => ({ op: name, args })
  return {
    db: {
      select: () => ({
        from: () => ({
          where: (where: unknown) => ({
            orderBy: () => ({
              limit: async (limit: number) => {
                hoisted.queries.push({ where, limit })
                return hoisted.pages.shift() ?? []
              },
            }),
          }),
        }),
      }),
    },
    auditLog: {
      id: 'id',
      occurredAt: 'occurred_at',
      eventType: 'event_type',
      actorEmail: 'actor_email',
    },
    and: op('and'),
    or: op('or'),
    eq: op('eq'),
    lt: op('lt'),
    gte: op('gte'),
    lte: op('lte'),
    ilike: op('ilike'),
    desc: op('desc'),
  }
})

const { auditExportPages, auditRowToCsv, parseAuditExportFilters, AUDIT_EXPORT_COLUMNS } =
  await import('../export')

function row(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `audit_${n}`,
    occurredAt: new Date(Date.UTC(2026, 8, 24, 0, 0, 60 - n)),
    eventType: 'user.role.changed',
    eventOutcome: 'success',
    actorUserId: 'user_1',
    actorEmail: 'ops@venturi.systems',
    actorRole: 'admin',
    actorType: 'user',
    authMethod: 'session',
    actorIp: '203.0.113.9',
    actorUserAgent: 'Mozilla/5.0',
    requestId: null,
    targetType: 'principal',
    targetId: 'principal_2',
    beforeValue: { role: 'member' },
    afterValue: { role: 'admin' },
    metadata: null,
    ...overrides,
  }
}

beforeEach(() => {
  hoisted.pages = []
  hoisted.queries = []
})

describe('auditExportPages', () => {
  it('pages with a keyset cursor until a short page', async () => {
    hoisted.pages = [[row(1), row(2)], [row(3)]]
    const seen: string[] = []
    for await (const page of auditExportPages({}, 2)) {
      seen.push(...page.rows.map((r) => r.id))
    }
    expect(seen).toEqual(['audit_1', 'audit_2', 'audit_3'])
    expect(hoisted.queries).toHaveLength(2)
    // The second page is bounded by the last row of the first.
    expect(JSON.stringify(hoisted.queries[1].where)).toContain('audit_2')
    expect(hoisted.queries[0].where).toBeUndefined()
  })

  it('applies the filters to every page', async () => {
    hoisted.pages = [[row(1)]]
    const pages = []
    for await (const page of auditExportPages(
      { eventType: 'board.deleted', actorEmail: 'ops', from: new Date('2026-09-01') },
      10
    )) {
      pages.push(page)
    }
    expect(pages).toHaveLength(1)
    const where = JSON.stringify(hoisted.queries[0].where)
    expect(where).toContain('board.deleted')
    expect(where).toContain('%ops%')
  })
})

describe('auditRowToCsv', () => {
  it('writes every column, before and after values included', () => {
    const line = auditRowToCsv(row(1))
    expect(line.split('","')).toHaveLength(AUDIT_EXPORT_COLUMNS.length - 1)
    expect(line).toContain('""role"":""member""')
    expect(line).toContain('""role"":""admin""')
    expect(line).toContain('Mozilla/5.0')
  })

  it('neutralises formula injection from externally supplied values', () => {
    const line = auditRowToCsv(row(1, { actorEmail: '=cmd|calc!A1', targetId: '@evil' }))
    expect(line).toContain(`"'=cmd|calc!A1"`)
    expect(line).toContain(`"'@evil"`)
  })
})

describe('parseAuditExportFilters', () => {
  it('reads the filters and ignores invalid dates and the all sentinel', () => {
    const f = parseAuditExportFilters(
      new URLSearchParams('eventType=all&actorEmail=Ops@Venturi.Systems&from=nope&to=2026-09-24')
    )
    expect(f.eventType).toBeUndefined()
    expect(f.actorEmail).toBe('ops@venturi.systems')
    expect(f.from).toBeUndefined()
    expect(f.to?.toISOString()).toBe('2026-09-24T00:00:00.000Z')
  })
})
