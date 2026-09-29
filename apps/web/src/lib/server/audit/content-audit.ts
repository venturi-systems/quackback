/**
 * Audit rows for tags, roadmaps and changelog entries (landing-page#2309,
 * extras report section 1).
 *
 * The same change can arrive from the admin UI (a session), the REST API (an
 * API key) or the MCP server (an OAuth token or an API key). Each caller
 * passes its own actor; the views, the before-value reads and the changelog
 * publish rule live here so the three paths record the same row.
 */

import type { McpAuthContext } from '@/lib/server/mcp/types'
import type { AuditActor, RecordAuditEventInput } from './log'
import { apiKeyAuditContext, recordAuditSafely, sessionAuditActor } from './audit-safe'

/** The tag fields an audit row records. */
export function tagAuditView(t: {
  name: string
  color?: string | null
  description?: string | null
}) {
  return { name: t.name, color: t.color ?? null, description: t.description ?? null }
}

/** The roadmap fields an audit row records (never its posts). */
export function roadmapAuditView(r: {
  name: string
  slug: string
  description?: string | null
  isPublic: boolean
}) {
  return {
    name: r.name,
    slug: r.slug,
    description: r.description ?? null,
    isPublic: r.isPublic,
  }
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

/** The changelog entry fields an audit row records (never its content). */
export function changelogAuditView(e: {
  title: string
  publishedAt?: Date | string | null
  displayDate?: Date | string | null
}) {
  return {
    title: e.title,
    publishedAt: isoOrNull(e.publishedAt),
    displayDate: isoOrNull(e.displayDate),
  }
}

export type ChangelogAuditView = ReturnType<typeof changelogAuditView>

/** A record's state before a change, for the audit row; null if unreadable. */
export async function auditSnapshot<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

/** Who made the change and how, as each caller knows it. */
export interface ContentAuditSource {
  actor: AuditActor
  metadata?: Record<string, unknown>
  headers?: Headers | 'request'
}

/** The audit source for a signed-in session (a requireAuth result). */
export function sessionAuditSource(
  auth: Parameters<typeof sessionAuditActor>[0]
): ContentAuditSource {
  return { actor: sessionAuditActor(auth), headers: 'request' }
}

/** The audit source for a REST call made with an API key (a withApiKeyAuth result). */
export function apiKeyAuditSource(
  auth: Parameters<typeof apiKeyAuditContext>[0],
  headers: Headers
): ContentAuditSource {
  return { ...apiKeyAuditContext(auth), headers }
}

/** Record one audit row for a tag, roadmap or changelog change. */
export async function recordContentAudit(
  source: ContentAuditSource,
  input: Omit<RecordAuditEventInput, 'headers' | 'actor' | 'metadata'>
): Promise<void> {
  await recordAuditSafely(
    {
      ...input,
      actor: source.actor,
      ...(source.metadata ? { metadata: source.metadata } : {}),
    },
    source.headers
  )
}

/**
 * One row for a created or updated changelog entry, and a
 * `changelog.published` row when the change gave the entry a publish date it
 * did not have (published now or scheduled): publishing is what notifies
 * subscribers.
 */
export async function recordChangelogChange(
  source: ContentAuditSource,
  event: 'changelog.created' | 'changelog.updated',
  id: string,
  before: ChangelogAuditView | null,
  after: ChangelogAuditView
): Promise<void> {
  const target = { type: 'changelog', id }
  await recordContentAudit(source, { event, target, before, after })
  if (after.publishedAt && !before?.publishedAt) {
    await recordContentAudit(source, { event: 'changelog.published', target, before, after })
  }
}

/**
 * Actor and metadata for a change made through the MCP server. An OAuth token
 * acts as its user; an API key as its service principal.
 */
export function mcpAuditSource(auth: McpAuthContext): ContentAuditSource {
  return {
    actor: {
      userId: auth.userId ?? null,
      email: auth.email ?? null,
      role: auth.role,
      type: auth.authMethod === 'api-key' ? 'api_key' : 'user',
      authMethod: auth.authMethod === 'api-key' ? 'api_key' : null,
    },
    metadata: { via: 'mcp', mcpAuthMethod: auth.authMethod, principalId: auth.principalId },
  }
}
