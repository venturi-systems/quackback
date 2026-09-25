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
 * Parse the stored `api_keys.scopes` JSON.
 *
 * A key created before scopes existed stores NULL (or only internal
 * capability scopes such as `internal:tier-limits`); it keeps full API access,
 * still bounded by its role, its creator's current role and its lifetime
 * (apiKeyExpiresAt). Any stored API scope makes the key scoped to exactly
 * those scopes.
 */
export function parseStoredApiKeyScopes(raw: string | null | undefined): {
  scopes: ApiKeyScope[]
  legacyFullAccess: boolean
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
  if (scopes.length === 0) return { scopes: [...API_KEY_SCOPES], legacyFullAccess: true }
  return { scopes: [...new Set(scopes)], legacyFullAccess: false }
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
 * secret and keeps everything else, so it would carry forward a key made
 * before scopes and expiry were required (full access, no stored expiry), and
 * it cannot bring back an expired key. Those are replaced instead: create a
 * scoped key that expires, move the integration to it, revoke the old one.
 *
 * `scopes` is the key's API scopes (null for full access), `expiresAt` its
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
