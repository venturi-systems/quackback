import { describe, it, expect } from 'vitest'
import {
  API_KEY_PRESETS,
  API_KEY_SCOPES,
  API_KEY_MAX_EXPIRY_DAYS,
  API_KEY_EXPIRY_OPTIONS_DAYS,
  DEFAULT_API_KEY_PRESET,
  hasApiKeyScope,
  isApiKeyScope,
  parseStoredApiKeyScopes,
} from '../api-key-scopes'

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
  it('keeps full access for a legacy key stored without scopes', () => {
    expect(parseStoredApiKeyScopes(null)).toEqual({
      scopes: [...API_KEY_SCOPES],
      legacyFullAccess: true,
    })
  })

  it('treats a key with only internal capability scopes as legacy', () => {
    expect(parseStoredApiKeyScopes('["internal:tier-limits"]').legacyFullAccess).toBe(true)
  })

  it('scopes a key to exactly its stored API scopes', () => {
    expect(parseStoredApiKeyScopes('["read:feedback","read:feedback","bogus"]')).toEqual({
      scopes: ['read:feedback'],
      legacyFullAccess: false,
    })
  })

  it('survives corrupt JSON as legacy', () => {
    expect(parseStoredApiKeyScopes('{not json').legacyFullAccess).toBe(true)
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
