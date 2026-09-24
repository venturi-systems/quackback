import { createFileRoute } from '@tanstack/react-router'

/**
 * GET /api/audit-log/export
 *
 * Administrator-only, server-side paged audit-log export as CSV
 * (landing-page#2309). Filters: eventType, actorEmail, from, to (ISO 8601).
 * Every column is included, before and after values too, as formula-safe
 * cells. The export itself is audited (`audit.exported`).
 */
export async function handleAuditLogExport({ request }: { request: Request }): Promise<Response> {
  const { validateApiWorkspaceAccess } = await import('@/lib/server/functions/workspace')
  const access = await validateApiWorkspaceAccess()
  if (!access.success) {
    return Response.json({ error: access.error }, { status: access.status })
  }
  if (access.principal.role !== 'admin') {
    return Response.json({ error: 'Only administrators can export the audit log' }, { status: 403 })
  }

  const { AUDIT_EXPORT_COLUMNS, auditExportPages, auditRowToCsv, parseAuditExportFilters } =
    await import('@/lib/server/audit/export')
  const filters = parseAuditExportFilters(new URL(request.url).searchParams)

  const encoder = new TextEncoder()
  let exported = 0
  let truncated = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(AUDIT_EXPORT_COLUMNS.join(',') + '\n'))
        for await (const page of auditExportPages(filters)) {
          for (const row of page.rows) controller.enqueue(encoder.encode(auditRowToCsv(row) + '\n'))
          exported += page.rows.length
          truncated = truncated || page.truncated
        }
        controller.close()
      } catch (error) {
        controller.error(error)
        return
      }
      const { recordAuditSafely, sessionAuditActor } = await import('@/lib/server/audit/audit-safe')
      await recordAuditSafely(
        {
          event: 'audit.exported',
          actor: sessionAuditActor({ user: access.user, principal: access.principal }),
          target: { type: 'audit_log' },
          metadata: {
            format: 'csv',
            rows: exported,
            truncated,
            filters: {
              eventType: filters.eventType ?? null,
              actorEmail: filters.actorEmail ?? null,
              from: filters.from?.toISOString() ?? null,
              to: filters.to?.toISOString() ?? null,
            },
          },
        },
        request.headers
      )
    },
  })

  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-log-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}

export const Route = createFileRoute('/api/audit-log/export')({
  server: {
    handlers: {
      GET: handleAuditLogExport,
    },
  },
})
