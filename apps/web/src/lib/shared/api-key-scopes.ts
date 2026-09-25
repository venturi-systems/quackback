/**
 * API key scopes: what one key may do, independent of who created it.
 *
 * A key's authority is the intersection of three things:
 *   1. its scopes (this file),
 *   2. the role of its service principal (copied from the creator at
 *      creation), and
 *   3. the creator's current role under the team identity rule
 *      (domains/api-keys/api-key-authority.ts).
 *
 * Status changes are never available to an API key or an MCP client,
 * whatever the scopes: a status change emails subscribers, so only a signed-in
 * team member makes one (owner rule, landing-page#2309).
 *
 * Shared by the server (REST and MCP enforcement) and the admin UI (the
 * scope picker and presets), so both read one vocabulary.
 */

export const API_KEY_SCOPES = [
  'read:feedback',
  'write:feedback',
  'write:changelog',
  'read:article',
  'write:article',
  'read:chat',
  'write:chat',
  'admin:workspace',
] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export const API_KEY_SCOPE_DESCRIPTIONS: Record<ApiKeyScope, { label: string; detail: string }> = {
  'read:feedback': {
    label: 'Read feedback',
    detail: 'Boards, posts, comments, votes, roadmaps, tags and statuses.',
  },
  'write:feedback': {
    label: 'Write feedback',
    detail: 'Create and edit posts, comments, votes, tags and roadmap items. Never status changes.',
  },
  'write:changelog': { label: 'Write changelog', detail: 'Create and edit changelog entries.' },
  'read:article': { label: 'Read help articles', detail: 'Help Center categories and articles.' },
  'write:article': { label: 'Write help articles', detail: 'Create and edit help articles.' },
  'read:chat': { label: 'Read conversations', detail: 'Support conversations and messages.' },
  'write:chat': { label: 'Write conversations', detail: 'Reply to support conversations.' },
  'admin:workspace': {
    label: 'Administer workspace',
    detail: 'Administrator-only endpoints such as webhooks and board deletion.',
  },
}

/** A write scope also grants the matching read scope. */
const IMPLIED_BY: Partial<Record<ApiKeyScope, ApiKeyScope[]>> = {
  'read:feedback': ['write:feedback'],
  'read:article': ['write:article'],
  'read:chat': ['write:chat'],
}

/** True when `granted` covers `required` (directly or through a write scope). */
export function hasApiKeyScope(granted: readonly string[], required: ApiKeyScope): boolean {
  if (granted.includes(required)) return true
  return (IMPLIED_BY[required] ?? []).some((scope) => granted.includes(scope))
}

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value)
}

/**
 * What a key stored without any API scope may do: read feedback and help
 * articles, the "Read only" preset.
 *
 * Such a key was created before every key had to be scoped (landing-page#2309,
 * DEF-15). Migration 9003_venturi_legacy_api_key_bounds.sql stores these scopes
 * on every such key it finds and records when (`legacy_bounded_at`); this
 * constant applies the same bound to any key the migration never saw. A
 * read-only integration keeps working; a key that wrote is replaced by a new
 * scoped key.
 */
export const LEGACY_API_KEY_SCOPES: readonly ApiKeyScope[] = ['read:feedback', 'read:article']

/**
 * How long a key the migration found without an expiry keeps working: the
 * default lifetime of a new key, counted from the migration. It is the notice
 * an administrator has to replace the key (docs/team-designation.md).
 */
export const LEGACY_API_KEY_NOTICE_DAYS = 90

/**
 * Parse the stored `api_keys.scopes` JSON.
 *
 * A key created before scopes existed stores NULL (or only internal
 * capability scopes such as `internal:tier-limits`): `legacyUnscoped` is true
 * and it gets LEGACY_API_KEY_SCOPES, never full access. It is still bounded by
 * its role, its creator's current role and its lifetime (apiKeyExpiresAt).
 * Any stored API scope makes the key scoped to exactly those scopes.
 */
export function parseStoredApiKeyScopes(raw: string | null | undefined): {
  scopes: ApiKeyScope[]
  legacyUnscoped: boolean
} {
  let parsed: unknown = null
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }
  const scopes = Array.isArray(parsed) ? parsed.filter(isApiKeyScope) : []
  if (scopes.length === 0) return { scopes: [...LEGACY_API_KEY_SCOPES], legacyUnscoped: true }
  return { scopes: [...new Set(scopes)], legacyUnscoped: false }
}

/**
 * The scopes a key works with: its stored API scopes, or LEGACY_API_KEY_SCOPES
 * for a key stored without any (`scopes: null` in the ApiKey shape).
 */
export function effectiveApiKeyScopes(scopes: readonly ApiKeyScope[] | null): ApiKeyScope[] {
  return scopes ? [...scopes] : [...LEGACY_API_KEY_SCOPES]
}

/** Longest lifetime a new key may have. */
export const API_KEY_MAX_EXPIRY_DAYS = 365

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When a key stops working. A key stored without an expiry (created before
 * every key had to expire) expires API_KEY_MAX_EXPIRY_DAYS after it was
 * created, the longest lifetime a new key may have, so no key lives forever
 * (landing-page#2309, DEF-15).
 */
export function apiKeyExpiresAt(storedExpiresAt: Date | null | undefined, createdAt: Date): Date {
  // new Date() also accepts the ISO string a serialized row may carry.
  if (storedExpiresAt) return new Date(storedExpiresAt)
  return new Date(new Date(createdAt).getTime() + API_KEY_MAX_EXPIRY_DAYS * DAY_MS)
}

/**
 * Why a key cannot be rotated, or null when it can. Rotation replaces the
 * secret and keeps everything else, so it would carry forward a key stored
 * without scopes or without an expiry, and it cannot bring back an expired
 * key. Those are replaced instead: create a scoped key that expires, move the
 * integration to it, revoke the old one. A key the legacy migration bounded
 * has both stored, so it rotates like any other key, keeping its read-only
 * scopes and its expiry.
 *
 * `scopes` is the key's stored API scopes (null for none), `expiresAt` its
 * STORED expiry (null for none), as the ApiKey shape reports them.
 */
export function apiKeyRotationBlocker(
  key: { scopes: readonly string[] | null; expiresAt: Date | null; createdAt: Date },
  now: number = Date.now()
): 'legacy' | 'expired' | null {
  if (key.scopes === null || key.expiresAt === null) return 'legacy'
  if (apiKeyExpiresAt(key.expiresAt, key.createdAt).getTime() <= now) return 'expired'
  return null
}

export const API_KEY_ROTATION_BLOCKED_MESSAGES: Record<'legacy' | 'expired', string> = {
  legacy:
    'This key was created before every key needed scopes and an expiry, so it cannot be rotated. Create a new key with the scopes it needs, move the integration to it, then revoke this one.',
  expired:
    'This key has expired, so it cannot be rotated. Create a new key, move the integration to it, then revoke this one.',
}

/** Lifetimes offered in the creation dialog. */
export const API_KEY_EXPIRY_OPTIONS_DAYS = [30, 90, 180, 365] as const

export const API_KEY_DEFAULT_EXPIRY_DAYS = 90

export interface ApiKeyPreset {
  id: 'read-only' | 'mem0-gateway' | 'feedback-read-write' | 'full'
  label: string
  description: string
  scopes: ApiKeyScope[]
}

/**
 * Creation presets. `mem0-gateway` is the documented read-only key for the
 * Mem0 Gateway MCP connector (docs/mem0-gateway-connector.md): the Gateway
 * grants only search, get_details, get_post_activity and list_suggestions, and
 * the key cannot write even if a grant were widened.
 */
export const API_KEY_PRESETS: readonly ApiKeyPreset[] = [
  {
    id: 'read-only',
    label: 'Read only',
    description: 'Reads feedback and help articles. Cannot change anything.',
    scopes: ['read:feedback', 'read:article'],
  },
  {
    id: 'mem0-gateway',
    label: 'Mem0 Gateway connector (read only)',
    description:
      'For the Mem0 Gateway MCP connector: search and read feedback only. Pair it with the 90-day expiry.',
    scopes: ['read:feedback'],
  },
  {
    id: 'feedback-read-write',
    label: 'Feedback read and write',
    description: 'Reads and writes feedback. Never changes a status.',
    scopes: ['read:feedback', 'write:feedback'],
  },
  {
    id: 'full',
    label: 'Full access',
    description: 'Every scope, including administrator-only endpoints. Never changes a status.',
    scopes: [...API_KEY_SCOPES],
  },
]

export const DEFAULT_API_KEY_PRESET: ApiKeyPreset['id'] = 'read-only'
