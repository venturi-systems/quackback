/**
 * Audit coverage for API key changes made in the admin UI (landing-page#2309,
 * ledger DEF-80). Each mutation in functions/api-keys.ts writes exactly one
 * audit row with its event, its target and the key's descriptive fields before
 * and after the change, never the key itself or its hash, and a mutation that
 * fails writes none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  recordAuditSafely: vi.fn(),
  requireAuth: vi.fn(),
  apiKeys: {
    listApiKeys: vi.fn(),
    getApiKeyById: vi.fn(),
    createApiKey: vi.fn(),
    updateApiKeyName: vi.fn(),
    rotateApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
  },
}))

vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    const chain = {
      validator() {
        return chain
      },
      handler(fn: unknown) {
        return fn
      },
    }
    return chain
  },
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({ requireAuth: hoisted.requireAuth }))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Unit tests must not open a database')
  },
}))
vi.mock('@/lib/server/audit/audit-safe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/audit/audit-safe')>()),
  recordAuditSafely: hoisted.recordAuditSafely,
}))
vi.mock('@/lib/server/domains/api-keys/api-key.service', () => hoisted.apiKeys)

import * as apiKeyFns from '../api-keys'

type Handler = (args: { data: Record<string, unknown> }) => Promise<unknown>
const call = (fn: unknown, data: Record<string, unknown>) => (fn as Handler)({ data })

function rows() {
  return hoisted.recordAuditSafely.mock.calls.map(([input]) => input as Record<string, unknown>)
}

/** What the real sessionAuditActor makes of the session mocked below. */
const ACTOR = {
  userId: 'user_admin1',
  email: 'admin@example.com',
  role: 'admin',
  type: 'user',
  authMethod: 'session',
}

/** Seven days out: in the future and inside API_KEY_MAX_EXPIRY_DAYS on any run day. */
const EXPIRES_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
/** Marks the key material and its hash, which no audit row may carry. */
const SECRET = 'full-key-material'
const KEY = {
  id: 'apikey_1',
  name: 'CI deploys',
  keyPrefix: 'qb_live_ab12',
  keyHash: `hash-of-${SECRET}`,
  scopes: ['read:feedback'],
  expiresAt: EXPIRES_AT,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  revokedAt: null,
}
const KEY_VIEW = {
  name: 'CI deploys',
  keyPrefix: 'qb_live_ab12',
  scopes: ['read:feedback'],
  expiresAt: EXPIRES_AT.toISOString(),
}
const ROTATED = { ...KEY, keyPrefix: 'qb_live_ef56', keyHash: `hash-of-rotated-${SECRET}` }
const CREATE = { name: 'CI deploys', scopes: ['read:feedback'], expiresAt: EXPIRES_AT.toISOString() }

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue({
    user: { id: 'user_admin1', email: 'admin@example.com', name: 'Admin' },
    principal: { id: 'principal_admin1', role: 'admin', type: 'user' },
  })
  hoisted.apiKeys.getApiKeyById.mockResolvedValue(KEY)
  hoisted.apiKeys.createApiKey.mockResolvedValue({ apiKey: KEY, key: `qb_live_ab12_${SECRET}` })
  hoisted.apiKeys.updateApiKeyName.mockResolvedValue({ ...KEY, name: 'Prod deploys' })
  hoisted.apiKeys.rotateApiKey.mockResolvedValue({ apiKey: ROTATED, key: `qb_live_ef56_${SECRET}` })
  hoisted.apiKeys.revokeApiKey.mockResolvedValue(undefined)
})

describe('API key changes write exactly one audit row each (DEF-80)', () => {
  it.each([
    {
      name: 'createApiKeyFn',
      event: 'api_key.created',
      data: CREATE,
      row: { target: { type: 'api_key', id: 'apikey_1' }, after: KEY_VIEW },
    },
    {
      name: 'updateApiKeyFn',
      event: 'api_key.renamed',
      data: { id: 'apikey_1', name: 'Prod deploys' },
      row: {
        target: { type: 'api_key', id: 'apikey_1' },
        before: { name: 'CI deploys' },
        after: { name: 'Prod deploys' },
      },
    },
    {
      name: 'rotateApiKeyFn',
      event: 'api_key.rotated',
      data: { id: 'apikey_1' },
      row: {
        target: { type: 'api_key', id: 'apikey_1' },
        after: { ...KEY_VIEW, keyPrefix: 'qb_live_ef56' },
      },
    },
    {
      name: 'revokeApiKeyFn',
      event: 'api_key.revoked',
      data: { id: 'apikey_1' },
      row: { target: { type: 'api_key', id: 'apikey_1' }, before: KEY_VIEW },
    },
  ])('$name records one $event row', async ({ name, event, data, row }) => {
    await call(apiKeyFns[name as keyof typeof apiKeyFns], data)
    expect(rows()).toEqual([{ event, actor: ACTOR, ...row }])
    expect(hoisted.recordAuditSafely).toHaveBeenCalledWith(expect.anything(), 'request')
    // Never the key or its hash: the row carries the prefix only.
    expect(JSON.stringify(rows())).not.toContain(SECRET)
  })

  it('records a key stored without scopes or expiry as legacy read-only', async () => {
    hoisted.apiKeys.getApiKeyById.mockResolvedValue({ ...KEY, scopes: null, expiresAt: null })
    await call(apiKeyFns.revokeApiKeyFn, { id: 'apikey_1' })
    expect(rows()).toEqual([
      expect.objectContaining({
        event: 'api_key.revoked',
        before: { ...KEY_VIEW, scopes: 'legacy-read-only', expiresAt: null },
      }),
    ])
  })

  it.each([
    { name: 'createApiKeyFn', service: 'createApiKey', data: CREATE },
    {
      name: 'updateApiKeyFn',
      service: 'updateApiKeyName',
      data: { id: 'apikey_1', name: 'Prod deploys' },
    },
    { name: 'rotateApiKeyFn', service: 'rotateApiKey', data: { id: 'apikey_1' } },
    { name: 'revokeApiKeyFn', service: 'revokeApiKey', data: { id: 'apikey_1' } },
  ])('$name records no row when the change itself fails', async ({ name, service, data }) => {
    hoisted.apiKeys[service as keyof typeof hoisted.apiKeys].mockRejectedValue(
      new Error('write failed')
    )
    await expect(call(apiKeyFns[name as keyof typeof apiKeyFns], data)).rejects.toThrow(
      'write failed'
    )
    expect(rows()).toEqual([])
  })

  it('records no row when the expiry is refused before any key exists', async () => {
    await expect(
      call(apiKeyFns.createApiKeyFn, { ...CREATE, expiresAt: '2020-01-01T00:00:00.000Z' })
    ).rejects.toThrow('An API key must expire in the future')
    expect(hoisted.apiKeys.createApiKey).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
  })

  it('still records a rename when the name before it cannot be read', async () => {
    hoisted.apiKeys.getApiKeyById.mockRejectedValue(new Error('read failed'))
    await call(apiKeyFns.updateApiKeyFn, { id: 'apikey_1', name: 'Prod deploys' })
    expect(rows()).toEqual([
      expect.objectContaining({
        event: 'api_key.renamed',
        before: null,
        after: { name: 'Prod deploys' },
      }),
    ])
  })

  it('checks the administrator role before reading or changing anything', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(call(apiKeyFns.revokeApiKeyFn, { id: 'apikey_1' })).rejects.toThrow(
      'Access denied'
    )
    expect(hoisted.requireAuth).toHaveBeenCalledWith({ roles: ['admin'] })
    expect(hoisted.apiKeys.getApiKeyById).not.toHaveBeenCalled()
    expect(hoisted.apiKeys.revokeApiKey).not.toHaveBeenCalled()
    expect(rows()).toEqual([])
  })
})
