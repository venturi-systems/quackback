/**
 * Admin audit-log feed. Renders a paginated table of recent security-
 * sensitive actions with filters (event type, outcome, time range)
 * and a CSV export of the currently-filtered window.
 */
import { useMemo, useState } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { useDebouncedValue } from '@/lib/client/hooks/use-debounced-value'
import { ArrowDownTrayIcon } from '@heroicons/react/24/solid'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { adminQueries } from '@/lib/client/queries/admin'
import type { AuditEventRow } from '@/lib/server/functions/audit-log'

/**
 * Event-type catalog for the filter dropdown. Mirrors the
 * AuditEventType union — sourced from the server to keep the two in
 * lockstep would be neat, but a curated short list is friendlier for
 * the dropdown.
 *
 * Shape: `{ label, value, group?, excludeByDefault? }`. Items without a
 * `group` appear at the top (ungrouped). `excludeByDefault` marks high-
 * volume events that should not be shown on initial load; honored by any
 * future multi-select variant of this filter.
 */
interface FilterEventOption {
  label: string
  value: string
  group?: string
  excludeByDefault?: boolean
}

const WIDGET_ACTIVITY_GROUP = 'Widget activity'

const FILTER_EVENT_TYPES: FilterEventOption[] = [
  { label: 'All events', value: 'all' },
  { label: 'SSO enforcement enabled (domain)', value: 'sso.enforcement.domain.enabled' },
  { label: 'SSO enforcement disabled (domain)', value: 'sso.enforcement.domain.disabled' },
  { label: 'SSO config changed', value: 'sso.config.changed' },
  { label: 'Password sign-in enabled', value: 'auth.password.enabled' },
  { label: 'Password sign-in disabled', value: 'auth.password.disabled' },
  { label: 'Email sign-in enabled', value: 'auth.magic_link.enabled' },
  { label: 'Email sign-in disabled', value: 'auth.magic_link.disabled' },
  { label: 'Two-factor reset by admin', value: 'two_factor.reset_by_admin' },
  // Workspace changes (landing-page#2309)
  { group: 'Workspace', label: 'Team role changed', value: 'user.role.changed' },
  { group: 'Workspace', label: 'Removed from team', value: 'user.removed' },
  { group: 'Workspace', label: 'Board created', value: 'board.created' },
  { group: 'Workspace', label: 'Board updated', value: 'board.updated' },
  { group: 'Workspace', label: 'Board deleted', value: 'board.deleted' },
  { group: 'Workspace', label: 'Board access changed', value: 'board.access.changed' },
  { group: 'Workspace', label: 'Post status changed', value: 'post.status.changed' },
  { group: 'Workspace', label: 'Status created', value: 'status.created' },
  { group: 'Workspace', label: 'Status updated', value: 'status.updated' },
  { group: 'Workspace', label: 'Status deleted', value: 'status.deleted' },
  { group: 'Workspace', label: 'Statuses reordered', value: 'status.reordered' },
  { group: 'Workspace', label: 'Settings changed', value: 'settings.changed' },
  { group: 'Workspace', label: 'Widget secret regenerated', value: 'widget.secret.regenerated' },
  { group: 'Developers', label: 'API key created', value: 'api_key.created' },
  { group: 'Developers', label: 'API key rotated', value: 'api_key.rotated' },
  { group: 'Developers', label: 'API key renamed', value: 'api_key.renamed' },
  { group: 'Developers', label: 'API key revoked', value: 'api_key.revoked' },
  { group: 'Developers', label: 'Webhook created', value: 'webhook.created' },
  { group: 'Developers', label: 'Webhook updated', value: 'webhook.updated' },
  { group: 'Developers', label: 'Webhook deleted', value: 'webhook.deleted' },
  { group: 'Developers', label: 'Webhook secret rotated', value: 'webhook.secret_rotated' },
  { group: 'Developers', label: 'Audit log exported', value: 'audit.exported' },
  // Portal events
  {
    group: 'Portal',
    label: 'Allowed domains changed',
    value: 'portal.allowed_domains.changed',
  },
  {
    group: 'Portal',
    label: 'Allowed segments changed',
    value: 'portal.allowed_segments.changed',
  },
  { group: 'Portal', label: 'Access denied', value: 'portal.access.denied' },
  { group: 'Portal', label: 'Invite accepted', value: 'portal.invite.accepted' },
  { group: 'Portal', label: 'Invite expired', value: 'portal.invite.expired' },
  { group: 'Portal', label: 'Invite link minted', value: 'portal.invite.link_minted' },
  { group: 'Portal', label: 'Invite resent', value: 'portal.invite.resent' },
  { group: 'Portal', label: 'Invite revoked', value: 'portal.invite.revoked' },
  { group: 'Portal', label: 'Invite sent', value: 'portal.invite.sent' },
  { group: 'Portal', label: 'Sign-in failed', value: 'auth.signin.failed' },
  { group: 'Portal', label: 'Visibility changed', value: 'portal.visibility.changed' },
  { group: 'Portal', label: 'Widget sign-in changed', value: 'portal.widget_signin.changed' },
  // Widget activity — separated because handshake events are high-volume on active workspaces.
  // portal.widget_handshake.consumed is flagged excludeByDefault for future multi-select support.
  {
    group: WIDGET_ACTIVITY_GROUP,
    label: 'Handshake consumed',
    value: 'portal.widget_handshake.consumed',
    excludeByDefault: true,
  },
  {
    group: WIDGET_ACTIVITY_GROUP,
    label: 'Handshake invalid',
    value: 'portal.widget_handshake.invalid',
  },
]

const TIME_RANGES = [
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'Last 90 days', value: '90d' },
  { label: 'All time', value: 'all' },
] as const

type TimeRange = (typeof TIME_RANGES)[number]['value']

/**
 * Convert the time-range pick to a stable ISO timestamp. Stable in
 * two senses: (1) rounded to the start of the current minute so two
 * calls within 60s produce the same string, which keeps the loader
 * prefetch and the component's mount call landing on the same React
 * Query cache entry; (2) idempotent for repeated calls with the same
 * range in the same minute.
 */
export function rangeToFromIso(range: TimeRange): string | undefined {
  if (range === 'all') return undefined
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  // Floor to the minute so SSR + hydrate land on the same query key.
  const minuteMs = 60 * 1000
  const now = Math.floor(Date.now() / minuteMs) * minuteMs
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Two-line timestamp: "May 13" above "12:48 AM". Keeps the When
 * column narrow without forcing the date string to wrap mid-word
 * when the table is squeezed by long target IDs. Year is omitted —
 * audit-log retention caps at 365 days by default so every row is
 * within the current year.
 */
function formatTimestamp(iso: string): { date: string; time: string; full: string } {
  const d = new Date(iso)
  return {
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    full: d.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
  }
}

function ActorCell({ row }: { row: AuditEventRow }) {
  // Anonymous + service principals don't have an email — fall back to
  // actorType so the row isn't a bare em-dash. This is the in-table
  // surface for the 0070_audit_log_observability migration's
  // actorType + authMethod columns; request_id stays in the CSV.
  const primary = row.actorEmail ?? (row.actorType ? `(${row.actorType})` : null)
  if (!primary) return <span className="text-muted-foreground">—</span>
  const subtitle = [row.actorRole, row.authMethod].filter(Boolean).join(' · ')
  return (
    <div className="flex flex-col">
      <span className="truncate">{primary}</span>
      {subtitle ? (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {subtitle}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Target cell: the type sits on the top line as a label and the ID
 * goes on a second line in monospace, truncated with a tooltip for
 * the full value. Stacking is what stops the long
 * `domain_01krf77nfbf23v3dmx5ztdjkzr` string from blowing out the
 * row width.
 */
function TargetCell({ row }: { row: AuditEventRow }) {
  if (!row.targetType) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {row.targetType}
      </span>
      {row.targetId ? (
        <span className="truncate font-mono text-[11px]" title={row.targetId}>
          {row.targetId}
        </span>
      ) : null}
    </div>
  )
}

function OutcomeBadge({ outcome }: { outcome: AuditEventRow['eventOutcome'] }) {
  return (
    <Badge variant={outcome === 'success' ? 'secondary' : 'destructive'} className="text-xs">
      {outcome}
    </Badge>
  )
}

/**
 * The server-side export URL for the current filters. The server pages
 * through every matching row (not only the ones loaded here) and includes
 * before and after values, as formula-safe CSV (routes/api/audit-log/export.ts).
 */
export function auditExportUrl(filters: {
  eventType?: string
  actorEmail?: string
  from?: string
}): string {
  const params = new URLSearchParams()
  if (filters.eventType) params.set('eventType', filters.eventType)
  if (filters.actorEmail) params.set('actorEmail', filters.actorEmail)
  if (filters.from) params.set('from', filters.from)
  const query = params.toString()
  return `/api/audit-log/export${query ? `?${query}` : ''}`
}

export function AuditLogPage() {
  const [eventType, setEventType] = useState<string>('all')
  const [timeRange, setTimeRange] = useState<TimeRange>('30d')
  const [actorEmailInput, setActorEmailInput] = useState<string>('')

  // Debounce so each keystroke doesn't fire a fresh server-fn request.
  // 300ms feels instant without spamming.
  const debouncedActorEmail = useDebouncedValue(actorEmailInput, 300)

  // High-volume events are hidden from the "All events" view by default —
  // admins who want to see them pick the specific event type from the
  // dropdown. No separate toggle: the dropdown selection already says
  // exactly what the admin wants to see.
  const defaultExcludedEventTypes = useMemo(
    () => FILTER_EVENT_TYPES.filter((o) => o.excludeByDefault).map((o) => o.value),
    []
  )

  const excludeEventTypes = useMemo(
    () => (eventType === 'all' ? defaultExcludedEventTypes : []),
    [eventType, defaultExcludedEventTypes]
  )

  const filters = useMemo(
    () => ({
      eventType: eventType === 'all' ? undefined : eventType,
      actorEmail: debouncedActorEmail.trim() || undefined,
      from: rangeToFromIso(timeRange),
      limit: 200,
      excludeEventTypes: excludeEventTypes.length > 0 ? excludeEventTypes : undefined,
    }),
    [eventType, timeRange, debouncedActorEmail, excludeEventTypes]
  )

  const { data } = useSuspenseQuery(adminQueries.auditEvents(filters))
  const rows = data.events

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={eventType} onValueChange={setEventType}>
            <SelectTrigger className="h-9 w-full sm:w-64 text-xs">
              <SelectValue placeholder="Event type" />
            </SelectTrigger>
            <SelectContent>
              {/* Ungrouped items first */}
              {FILTER_EVENT_TYPES.filter((o) => !o.group).map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
              {/* Grouped items */}
              {Array.from(
                new Set(FILTER_EVENT_TYPES.filter((o) => !!o.group).map((o) => o.group!))
              ).map((group) => (
                <SelectGroup key={group}>
                  <SelectLabel className="text-xs font-semibold text-muted-foreground px-2 py-1">
                    {group}
                  </SelectLabel>
                  {group === WIDGET_ACTIVITY_GROUP && (
                    <p className="px-2 pb-1 text-[10px] text-muted-foreground leading-snug">
                      High-volume on active workspaces. Pick a specific event to view it.
                    </p>
                  )}
                  {FILTER_EVENT_TYPES.filter((o) => o.group === group).map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-xs">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
            <SelectTrigger className="h-9 w-full sm:w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="search"
            placeholder="Filter by actor email"
            value={actorEmailInput}
            onChange={(e) => setActorEmailInput(e.target.value)}
            className="h-9 w-full sm:w-56 text-xs"
            aria-label="Filter audit events by actor email"
          />
        </div>
        <Button variant="outline" size="sm" className="h-9" asChild>
          <a
            href={auditExportUrl(filters)}
            download
            aria-label="Export every matching audit event as CSV"
          >
            <ArrowDownTrayIcon className="size-3.5" />
            Export CSV
          </a>
        </Button>
      </div>

      {/* md+: horizontal-scrolling fixed-width table. `overflow-x-auto`
       *  lets the table scroll rather than wrapping cells into
       *  single-word columns. `table-fixed` + explicit widths give the
       *  browser stable layout targets. */}
      <div className="hidden md:block overflow-x-auto rounded-md border">
        <Table className="table-fixed text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[7rem]">When</TableHead>
              <TableHead className="w-[18rem]">Event</TableHead>
              <TableHead className="w-[16rem]">Actor</TableHead>
              <TableHead className="w-[18rem]">Target</TableHead>
              <TableHead className="w-[5rem]">Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No audit events match these filters yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const stamp = formatTimestamp(row.occurredAt)
                return (
                  <TableRow key={row.id}>
                    <TableCell
                      className="whitespace-nowrap text-muted-foreground"
                      title={stamp.full}
                    >
                      <div className="flex flex-col leading-tight">
                        <span>{stamp.date}</span>
                        <span className="text-[10px]">{stamp.time}</span>
                      </div>
                    </TableCell>
                    <TableCell className="truncate font-mono" title={row.eventType}>
                      {row.eventType}
                    </TableCell>
                    <TableCell className="truncate">
                      <ActorCell row={row} />
                    </TableCell>
                    <TableCell>
                      <TargetCell row={row} />
                    </TableCell>
                    <TableCell>
                      <OutcomeBadge outcome={row.eventOutcome} />
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* below md: stacked event cards */}
      <div className="md:hidden rounded-md border divide-y divide-border">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No audit events match these filters yet.
          </p>
        ) : (
          rows.map((row) => {
            const stamp = formatTimestamp(row.occurredAt)
            return (
              <div key={row.id} className="p-3 space-y-2">
                {/* Primary: event type + outcome */}
                <div className="flex items-start justify-between gap-2">
                  <span
                    className="font-mono text-xs truncate text-foreground"
                    title={row.eventType}
                  >
                    {row.eventType}
                  </span>
                  <OutcomeBadge outcome={row.eventOutcome} />
                </div>
                {/* Secondary fields */}
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div className="flex gap-2">
                    <span className="w-12 shrink-0 font-medium text-foreground/60">When</span>
                    <span title={stamp.full}>
                      {stamp.date} {stamp.time}
                    </span>
                  </div>
                  {row.actorEmail && (
                    <div className="flex gap-2">
                      <span className="w-12 shrink-0 font-medium text-foreground/60">Actor</span>
                      <span className="truncate">{row.actorEmail}</span>
                    </div>
                  )}
                  {row.targetType && (
                    <div className="flex gap-2">
                      <span className="w-12 shrink-0 font-medium text-foreground/60">Target</span>
                      <div className="min-w-0">
                        <span className="uppercase tracking-wide text-[10px]">
                          {row.targetType}
                        </span>
                        {row.targetId && (
                          <p className="font-mono text-[11px] truncate" title={row.targetId}>
                            {row.targetId}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {data.hasMore ? (
        <p className="text-xs text-muted-foreground">
          Showing the most recent {rows.length} events. Narrow the filters to see older entries.
        </p>
      ) : null}
    </div>
  )
}
