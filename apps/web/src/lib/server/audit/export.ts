/**
 * Server-side audit-log export (landing-page#2309).
 *
 * The admin page used to build a CSV from the (at most 200) rows it had
 * loaded, without before and after values. This export pages through every
 * matching row on the server with a keyset cursor on (occurred_at, id), so it
 * is bounded in memory whatever the size of the log, and it carries every
 * column, including before and after values, as formula-safe CSV cells.
 */

import type { SQL } from 'drizzle-orm'
import { csvLine } from '@/lib/shared/csv-cell'

export interface AuditExportFilters {
  eventType?: string
  actorEmail?: string
  from?: Date
  to?: Date
}

/** Rows fetched per page. */
export const AUDIT_EXPORT_PAGE_SIZE = 500

/** Hard ceiling on rows in one export; the response says when it was reached. */
export const AUDIT_EXPORT_MAX_ROWS = 250_000

export const AUDIT_EXPORT_COLUMNS = [
  'id',
  'occurred_at',
  'event_type',
  'outcome',
  'actor_user_id',
  'actor_email',
  'actor_role',
  'actor_type',
  'auth_method',
  'actor_ip',
  'actor_user_agent',
  'request_id',
  'target_type',
  'target_id',
  'before_value',
  'after_value',
  'metadata',
] as const

interface AuditRow {
  id: string
  occurredAt: Date
  eventType: string
  eventOutcome: string
  actorUserId: string | null
  actorEmail: string | null
  actorRole: string | null
  actorType: string | null
  authMethod: string | null
  actorIp: string | null
  actorUserAgent: string | null
  requestId: string | null
  targetType: string | null
  targetId: string | null
  beforeValue: unknown
  afterValue: unknown
  metadata: unknown
}

export function auditRowToCsv(row: AuditRow): string {
  return csvLine([
    row.id,
    row.occurredAt.toISOString(),
    row.eventType,
    row.eventOutcome,
    row.actorUserId,
    row.actorEmail,
    row.actorRole,
    row.actorType,
    row.authMethod,
    row.actorIp,
    row.actorUserAgent,
    row.requestId,
    row.targetType,
    row.targetId,
    row.beforeValue,
    row.afterValue,
    row.metadata,
  ])
}

/** Parse export filters from query parameters; invalid dates are ignored. */
export function parseAuditExportFilters(params: URLSearchParams): AuditExportFilters {
  const date = (key: string) => {
    const raw = params.get(key)
    if (!raw) return undefined
    const parsed = new Date(raw)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }
  const eventType = params.get('eventType')?.trim()
  const actorEmail = params.get('actorEmail')?.trim().toLowerCase()
  return {
    eventType: eventType && eventType !== 'all' ? eventType.slice(0, 128) : undefined,
    actorEmail: actorEmail ? actorEmail.slice(0, 254) : undefined,
    from: date('from'),
    to: date('to'),
  }
}

/**
 * Every matching audit row, newest first, one page at a time. Stops at
 * AUDIT_EXPORT_MAX_ROWS and reports whether it did.
 */
export async function* auditExportPages(
  filters: AuditExportFilters,
  pageSize: number = AUDIT_EXPORT_PAGE_SIZE
): AsyncGenerator<{ rows: AuditRow[]; truncated: boolean }> {
  const { db, auditLog, and, desc, eq, gte, lte, ilike, or, lt } = await import('@/lib/server/db')

  const base: SQL[] = []
  if (filters.eventType) base.push(eq(auditLog.eventType, filters.eventType))
  if (filters.actorEmail) base.push(ilike(auditLog.actorEmail, `%${filters.actorEmail}%`))
  if (filters.from) base.push(gte(auditLog.occurredAt, filters.from))
  if (filters.to) base.push(lte(auditLog.occurredAt, filters.to))

  let cursor: { occurredAt: Date; id: string } | null = null
  let total = 0
  for (;;) {
    const conditions = [...base]
    if (cursor) {
      const keyset = or(
        lt(auditLog.occurredAt, cursor.occurredAt),
        // lt() binds the id through the column's TypeID mapping (uuid storage).
        and(eq(auditLog.occurredAt, cursor.occurredAt), lt(auditLog.id, cursor.id as never))
      )
      if (keyset) conditions.push(keyset)
    }
    const remaining = AUDIT_EXPORT_MAX_ROWS - total
    const rows = (await db
      .select()
      .from(auditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
      .limit(Math.min(pageSize, remaining))) as unknown as AuditRow[]

    total += rows.length
    const truncated = total >= AUDIT_EXPORT_MAX_ROWS && rows.length > 0
    yield { rows, truncated }
    if (rows.length < pageSize || truncated) return
    const last = rows[rows.length - 1]
    cursor = { occurredAt: last.occurredAt, id: last.id }
  }
}
