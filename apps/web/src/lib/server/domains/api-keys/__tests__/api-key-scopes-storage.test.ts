/**
 * API keys carry per-key scopes (landing-page#2309). createApiKey stores the
 * chosen scopes and refuses unknown ones; the public ApiKey shape exposes the
 * API scopes (null for a legacy key) and never the internal capability scopes.
 *
 * DEF-15: every key is scoped and expires. createApiKey refuses a key without
 * scopes or an expiry, a key stored without an expiry stops working
 * API_KEY_MAX_EXPIRY_DAYS after creation, and rotateApiKey refuses a legacy
 * or expired key instead of renewing its secret.
 */
import { createHash } from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  row: null as null | Record<string, unknown>,
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      principal: { findFirst: async () => ({ role: 'admin' }) },
      apiKeys: { findFirst: async () => hoisted.row },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        hoisted.inserted.push(v)
        return {
          returning: async () => [
            {
              id: 'api_key_1',
              keyHash: 'h',
              keyPrefix: 'qb_abc',
              createdById: 'principal_creator',
              principalId: 'principal_service',
              lastUsedAt: null,
              createdAt: new Date('2026-09-24'),
              revokedAt: null,
              ...v,
            },
          ],
        }
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          hoisted.updates.push(v)
          return {
            returning: async () => (hoisted.row ? [{ ...hoisted.row, ...v }] : []),
            execute: async () => undefined,
          }
        },
      }),
    }),
  },
  apiKeys: { id: 'id', keyPrefix: 'key_prefix', revokedAt: 'revoked_at' },
  principal: { id: 'id' },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}))

vi.mock('@/lib/server/domains/principals/principal.service', () => ({
  createServicePrincipal: async () => ({ id: 'principal_service' }),
}))

const { createApiKey, getApiKeyById, rotateApiKey, verifyApiKey } =
  await import('../api-key.service')

const DAY_MS = 24 * 60 * 60 * 1000
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS)

beforeEach(() => {
  hoisted.inserted.length = 0
  hoisted.updates.length = 0
  hoisted.row = null
})

describe('createApiKey scopes', () => {
  it('stores the chosen scopes and reports them', async () => {
    const result = await createApiKey(
      { name: 'Gateway', scopes: ['read:feedback'], expiresAt: new Date('2026-12-24') },
      'principal_creator' as never
    )
    expect(hoisted.inserted[0]).toMatchObject({ scopes: '["read:feedback"]' })
    expect(result.apiKey.scopes).toEqual(['read:feedback'])
    expect(result.apiKey.expiresAt).toEqual(new Date('2026-12-24'))
  })

  it('refuses an empty or unknown scope list', async () => {
    await expect(
      createApiKey({ name: 'x', scopes: [], expiresAt: inDays(30) }, 'principal_creator' as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      createApiKey(
        { name: 'x', scopes: ['internal:tier-limits' as never], expiresAt: inDays(30) },
        'p' as never
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('refuses a key without scopes or without an expiry, whatever the caller', async () => {
    // The shape of a key made before scopes and expiry were required.
    await expect(
      createApiKey(
        { name: 'x', expiresAt: inDays(30) } as unknown as Parameters<typeof createApiKey>[0],
        'p' as never
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      createApiKey(
        { name: 'x', scopes: ['read:feedback'] } as unknown as Parameters<typeof createApiKey>[0],
        'p' as never
      )
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(hoisted.inserted).toEqual([])
  })
})

describe('ApiKey shape', () => {
  const base = {
    id: 'api_key_1',
    name: 'k',
    keyHash: 'h',
    keyPrefix: 'qb_abc',
    createdById: null,
    principalId: 'principal_service',
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    revokedAt: null,
  }

  it('reports null scopes for a legacy key and hides internal scopes', async () => {
    hoisted.row = { ...base, scopes: '["internal:tier-limits"]' }
    const key = await getApiKeyById('api_key_1' as never)
    expect(key.scopes).toBeNull()
    expect(JSON.stringify(key)).not.toContain('internal:tier-limits')
    expect(key).not.toHaveProperty('keyHash')
  })
})

describe('legacy keys (DEF-15)', () => {
  const plainTextKey = `qb_${'a1'.repeat(24)}`
  const stored = {
    id: 'api_key_1',
    name: 'k',
    keyHash: createHash('sha256').update(plainTextKey).digest('hex'),
    keyPrefix: plainTextKey.substring(0, 12),
    createdById: null,
    principalId: 'principal_service',
    lastUsedAt: null,
    revokedAt: null,
  }

  it('stops accepting a key stored without an expiry a year after it was created', async () => {
    hoisted.row = { ...stored, scopes: null, expiresAt: null, createdAt: inDays(-366) }
    expect(await verifyApiKey(plainTextKey)).toBeNull()
  })

  it('still accepts a key stored without an expiry inside that year', async () => {
    hoisted.row = { ...stored, scopes: null, expiresAt: null, createdAt: inDays(-30) }
    expect(await verifyApiKey(plainTextKey)).toMatchObject({ id: 'api_key_1', scopes: null })
  })

  it('refuses to rotate a key created before scopes existed', async () => {
    hoisted.row = { ...stored, scopes: null, expiresAt: inDays(30), createdAt: inDays(-30) }
    await expect(rotateApiKey('api_key_1' as never)).rejects.toMatchObject({
      code: 'API_KEY_NOT_ROTATABLE',
    })
    expect(hoisted.updates).toEqual([])
  })

  it('refuses to rotate a key stored without an expiry', async () => {
    hoisted.row = {
      ...stored,
      scopes: '["read:feedback"]',
      expiresAt: null,
      createdAt: inDays(-30),
    }
    await expect(rotateApiKey('api_key_1' as never)).rejects.toMatchObject({
      code: 'API_KEY_NOT_ROTATABLE',
    })
    expect(hoisted.updates).toEqual([])
  })

  it('refuses to rotate an expired key', async () => {
    hoisted.row = {
      ...stored,
      scopes: '["read:feedback"]',
      expiresAt: inDays(-1),
      createdAt: inDays(-91),
    }
    await expect(rotateApiKey('api_key_1' as never)).rejects.toMatchObject({
      code: 'API_KEY_NOT_ROTATABLE',
    })
    expect(hoisted.updates).toEqual([])
  })

  it('rotates a scoped key that has not expired, keeping its scopes and expiry', async () => {
    const expiresAt = inDays(60)
    hoisted.row = { ...stored, scopes: '["read:feedback"]', expiresAt, createdAt: inDays(-30) }
    const result = await rotateApiKey('api_key_1' as never)
    expect(result.plainTextKey).not.toBe(plainTextKey)
    expect(result.apiKey).toMatchObject({ scopes: ['read:feedback'], expiresAt })
    expect(Object.keys(hoisted.updates[0]).sort()).toEqual(['keyHash', 'keyPrefix', 'lastUsedAt'])
  })

  it('answers not found for a missing or revoked key', async () => {
    hoisted.row = null
    await expect(rotateApiKey('api_key_1' as never)).rejects.toMatchObject({
      code: 'API_KEY_NOT_FOUND',
    })
  })
})
