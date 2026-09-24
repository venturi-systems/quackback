/**
 * API keys carry per-key scopes (landing-page#2309). createApiKey stores the
 * chosen scopes and refuses unknown ones; the public ApiKey shape exposes the
 * API scopes (null for a legacy key) and never the internal capability scopes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
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
    update: () => ({ set: () => ({ where: async () => undefined }) }),
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

const { createApiKey, getApiKeyById } = await import('../api-key.service')

beforeEach(() => {
  hoisted.inserted.length = 0
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
      createApiKey({ name: 'x', scopes: [] }, 'principal_creator' as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      createApiKey({ name: 'x', scopes: ['internal:tier-limits' as never] }, 'p' as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
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
