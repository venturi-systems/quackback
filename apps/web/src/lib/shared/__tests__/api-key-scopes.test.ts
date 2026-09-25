import { describe, it, expect } from 'vitest'
import {
  API_KEY_PRESETS,
  API_KEY_SCOPES,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_EXPIRY_OPTIONS_DAYS,
  API_KEY_DEFAULT_EXPIRY_DAYS,
  DEFAULT_API_KEY_PRESET,
  LEGACY_API_KEY_NOTICE_DAYS,
  LEGACY_API_KEY_SCOPES,
  apiKeyExpiresAt,
  apiKeyRotationBlocker,
  effectiveApiKeyScopes,
  hasApiKeyScope,
  isApiKeyScope,
  parseStoredApiKeyScopes,
} from '../api-key-scopes'

const DAY_MS = 24 * 60 * 60 * 1000

describe('hasApiKeyScope', () => {
  it('grants a scope the key carries', () => {
    expect(hasApiKeyScope(['read:feedback'], 'read:feedback')).toBe(true)
  })

  it('lets a write scope imply its read scope, never the reverse', () => {
    expect(hasApiKeyScope(['write:feedback'], 'read:feedback')).toBe(true)
    expect(hasApiKeyScope(['write:article'], 'read:article')).toBe(true)
    expect(hasApiKeyScope(['write:chat'], 'read:chat')).toBe(true)
    expect(hasApiKeyScope(['read:feedback'], 'write:feedback')).toBe(false)
  })

  it('never lets feedback scopes reach administrator endpoints', () => {
    expect(hasApiKeyScope(['read:feedback', 'write:feedback'], 'admin:workspace')).toBe(false)
  })
})

describe('parseStoredApiKeyScopes', () => {
  it('reads only for a key stored without scopes, never full access (DEF-15)', () => {
    expect(parseStoredApiKeyScopes(null)).toEqual({
      scopes: ['read:feedback', 'read:article'],
      legacyUnscoped: true,
    })
    expect(parseStoredApiKeyScopes(null).scopes).toEqual([...LEGACY_API_KEY_SCOPES])
    expect(parseStoredApiKeyScopes(null).scopes).not.toContain('write:feedback')
    expect(parseStoredApiKeyScopes(null).scopes).not.toContain('admin:workspace')
  })

  it('treats a key with only internal capability scopes as legacy', () => {
    expect(parseStoredApiKeyScopes('["internal:tier-limits"]')).toEqual({
      scopes: [...LEGACY_API_KEY_SCOPES],
      legacyUnscoped: true,
    })
  })

  it('scopes a key to exactly its stored API scopes', () => {
    expect(parseStoredApiKeyScopes('["read:feedback","read:feedback","bogus"]')).toEqual({
      scopes: ['read:feedback'],
      legacyUnscoped: false,
    })
  })

  it('reads the jsonb text form the legacy migration writes', () => {
    expect(
      parseStoredApiKeyScopes('["internal:tier-limits", "read:article", "read:feedback"]')
    ).toEqual({ scopes: ['read:article', 'read:feedback'], legacyUnscoped: false })
  })

  it('survives corrupt JSON as legacy, read only', () => {
    expect(parseStoredApiKeyScopes('{not json')).toEqual({
      scopes: [...LEGACY_API_KEY_SCOPES],
      legacyUnscoped: true,
    })
  })
})

describe('LEGACY_API_KEY_SCOPES', () => {
  it('is the read-only preset', () => {
    const readOnly = API_KEY_PRESETS.find((p) => p.id === 'read-only')
    expect([...LEGACY_API_KEY_SCOPES]).toEqual(readOnly?.scopes)
    expect(LEGACY_API_KEY_SCOPES.every((scope) => scope.startsWith('read:'))).toBe(true)
  })

  it('gives the notice period of a new key\'s default lifetime', () => {
    expect(LEGACY_API_KEY_NOTICE_DAYS).toBe(API_KEY_DEFAULT_EXPIRY_DAYS)
  })
})

describe('effectiveApiKeyScopes', () => {
  it('keeps stored scopes', () => {
    expect(effectiveApiKeyScopes(['write:feedback'])).toEqual(['write:feedback'])
  })

  it('reads only for a key stored without scopes', () => {
    const scopes = effectiveApiKeyScopes(null)
    expect(scopes).toEqual([...LEGACY_API_KEY_SCOPES])
    for (const scope of API_KEY_SCOPES) {
      if (!scope.startsWith('read:')) expect(scopes).not.toContain(scope)
    }
  })

  it('returns a copy the caller may change', () => {
    const scopes = effectiveApiKeyScopes(null)
    scopes.push('admin:workspace')
    expect(LEGACY_API_KEY_SCOPES).not.toContain('admin:workspace')
  })
})

describe('presets', () => {
  it('defaults to the read-only preset', () => {
    const preset = API_KEY_PRESETS.find((p) => p.id === DEFAULT_API_KEY_PRESET)
    expect(preset?.scopes.every((s) => s.startsWith('read:'))).toBe(true)
  })

  it('documents a read-only Mem0 Gateway connector preset', () => {
    const gateway = API_KEY_PRESETS.find((p) => p.id === 'mem0-gateway')
    expect(gateway?.scopes).toEqual(['read:feedback'])
  })

  it('only offers known scopes', () => {
    for (const preset of API_KEY_PRESETS) {
      expect(preset.scopes.every(isApiKeyScope)).toBe(true)
    }
  })

  it('never offers a lifetime beyond the maximum', () => {
    expect(Math.max(...API_KEY_EXPIRY_OPTIONS_DAYS)).toBeLessThanOrEqual(API_KEY_MAX_EXPIRY_DAYS)
  })
})

describe('apiKeyExpiresAt (DEF-15: no key lives forever)', () => {
  const createdAt = new Date('2026-07-01T00:00:00Z')

  it('keeps a stored expiry', () => {
    const stored = new Date('2026-10-01T00:00:00Z')
    expect(apiKeyExpiresAt(stored, createdAt)).toEqual(stored)
  })

  it('expires a key stored without an expiry the maximum lifetime after creation', () => {
    expect(apiKeyExpiresAt(null, createdAt).getTime()).toBe(
      createdAt.getTime() + API_KEY_MAX_EXPIRY_DAYS * DAY_MS
    )
  })

  it('reads the ISO strings a serialized row carries', () => {
    const iso = '2026-10-01T00:00:00.000Z' as unknown as Date
    expect(apiKeyExpiresAt(iso, createdAt).toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })
})

describe('apiKeyRotationBlocker', () => {
  const createdAt = new Date('2026-07-01T00:00:00Z')
  const now = new Date('2026-09-25T00:00:00Z').getTime()

  it('lets a scoped key that has not expired rotate', () => {
    const key = { scopes: ['read:feedback'], expiresAt: new Date(now + DAY_MS), createdAt }
    expect(apiKeyRotationBlocker(key, now)).toBeNull()
  })

  it('refuses a key created before scopes existed', () => {
    const key = { scopes: null, expiresAt: new Date(now + DAY_MS), createdAt }
    expect(apiKeyRotationBlocker(key, now)).toBe('legacy')
  })

  it('refuses a key stored without an expiry, even with scopes', () => {
    expect(
      apiKeyRotationBlocker({ scopes: ['read:feedback'], expiresAt: null, createdAt }, now)
    ).toBe('legacy')
  })

  it('refuses an expired key', () => {
    const key = { scopes: ['read:feedback'], expiresAt: new Date(now - 1), createdAt }
    expect(apiKeyRotationBlocker(key, now)).toBe('expired')
  })
})
