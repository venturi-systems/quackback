/**
 * Unit tests for the refresh-token rotation grace heal
 * (`handleRefreshGraceHeal`).
 *
 * The hook's only write is un-revoking a presented refresh token whose
 * revocation is evidenced as a *rotation* (a successor row created at the
 * exact revocation timestamp) within the grace window. Everything else must
 * fall through untouched so the oauth-provider plugin keeps its vanilla
 * behavior — including the family revocation on beyond-grace reuse and on
 * reuse of deliberately revoked (RFC 7009) tokens, which leave no successor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockFindFirst, mockUpdateSet, mockUpdate, mockRecordAuditEvent, grace } = vi.hoisted(() => {
  const mockUpdateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }))
  return {
    mockFindFirst: vi.fn(),
    mockUpdateSet,
    mockUpdate: vi.fn(() => ({ set: mockUpdateSet })),
    mockRecordAuditEvent: vi.fn(async () => undefined),
    grace: { seconds: 7 * 24 * 60 * 60 },
  }
})

vi.mock('@/lib/server/db', () => ({
  db: {
    query: { oauthRefreshToken: { findFirst: mockFindFirst } },
    update: mockUpdate,
  },
  oauthRefreshToken: {
    id: 'col:id',
    token: 'col:token',
    clientId: 'col:clientId',
    userId: 'col:userId',
    createdAt: 'col:createdAt',
    revoked: 'col:revoked',
  },
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: [c, v] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}))

vi.mock('@/lib/server/audit/log', () => ({
  recordAuditEvent: mockRecordAuditEvent,
}))

vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers(),
}))

vi.mock('@/lib/server/config', () => ({
  config: {
    get oauthRefreshGraceSeconds() {
      return grace.seconds
    },
  },
}))

import { handleRefreshGraceHeal, hashRefreshToken } from '../refresh-grace'

const NOW = Date.now()
const CLIENT_ID = 'client_abc'
const USER_ID = 'user_123'
const WIRE_TOKEN = 'test-refresh-token-value'

function tokenCtx(overrides?: { body?: Record<string, unknown> | null; path?: string }) {
  return {
    path: overrides?.path ?? '/oauth2/token',
    body:
      overrides?.body === null
        ? undefined
        : {
            grant_type: 'refresh_token',
            refresh_token: WIRE_TOKEN,
            client_id: CLIENT_ID,
            ...overrides?.body,
          },
  }
}

/** A refresh row rotated `agoMs` ago (revocation evidenced by a successor). */
function rotatedRow(agoMs: number, overrides?: Record<string, unknown>) {
  return {
    id: 'rt_old',
    clientId: CLIENT_ID,
    userId: USER_ID,
    revoked: new Date(NOW - agoMs),
    expiresAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(NOW - agoMs - 1000),
    scopes: ['read:feedback', 'offline_access'],
    ...overrides,
  }
}

const successorRow = { id: 'rt_new' }

beforeEach(() => {
  vi.clearAllMocks()
  grace.seconds = 7 * 24 * 60 * 60
})

describe('hashRefreshToken', () => {
  it('matches the oauth-provider storeTokens "hashed" format (SHA-256 → unpadded base64url)', () => {
    // Frozen vector — if this ever changes, stored-token lookups silently
    // miss and the heal becomes a no-op. The live OAuth repro pins the
    // same assumption end-to-end against the real plugin.
    expect(hashRefreshToken(WIRE_TOKEN)).toBe('S28e2fm6zbU08siTOB53KZ-qNu7D93_OwIzBgZaqZZs')
  })
})

describe('handleRefreshGraceHeal', () => {
  it('ignores non-token endpoints without touching the DB', async () => {
    await handleRefreshGraceHeal({ path: '/sign-in/email', body: { grant_type: 'refresh_token' } })
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  it('ignores non-refresh grant types without touching the DB', async () => {
    await handleRefreshGraceHeal(tokenCtx({ body: { grant_type: 'authorization_code' } }))
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  it('ignores requests missing refresh_token or client_id', async () => {
    await handleRefreshGraceHeal(tokenCtx({ body: { refresh_token: undefined } }))
    await handleRefreshGraceHeal(tokenCtx({ body: { client_id: undefined } }))
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  it('does nothing when grace is disabled (0 seconds)', async () => {
    grace.seconds = 0
    await handleRefreshGraceHeal(tokenCtx())
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  it('does nothing for unknown tokens', async () => {
    mockFindFirst.mockResolvedValueOnce(null)
    await handleRefreshGraceHeal(tokenCtx())
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('does nothing for valid (un-revoked) tokens', async () => {
    mockFindFirst.mockResolvedValueOnce(rotatedRow(60_000, { revoked: null }))
    await handleRefreshGraceHeal(tokenCtx())
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('heals a rotated token within grace: un-revokes and audits', async () => {
    mockFindFirst.mockResolvedValueOnce(rotatedRow(60_000)).mockResolvedValueOnce(successorRow)

    await handleRefreshGraceHeal(tokenCtx())

    expect(mockUpdateSet).toHaveBeenCalledWith({ revoked: null })
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'oauth.refresh_token.grace_heal' })
    )
  })

  it('does NOT heal a revoked token with no rotation successor (RFC 7009 revocation)', async () => {
    mockFindFirst.mockResolvedValueOnce(rotatedRow(60_000)).mockResolvedValueOnce(null)

    await handleRefreshGraceHeal(tokenCtx())

    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockRecordAuditEvent).not.toHaveBeenCalled()
  })

  it('does NOT heal beyond the grace window', async () => {
    mockFindFirst.mockResolvedValueOnce(rotatedRow(8 * 24 * 60 * 60 * 1000))
    await handleRefreshGraceHeal(tokenCtx())
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('does NOT heal expired tokens', async () => {
    mockFindFirst.mockResolvedValueOnce(rotatedRow(60_000, { expiresAt: new Date(NOW - 1000) }))
    await handleRefreshGraceHeal(tokenCtx())
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('does NOT heal when the presented client_id does not own the token', async () => {
    mockFindFirst.mockResolvedValueOnce(rotatedRow(60_000, { clientId: 'client_other' }))
    await handleRefreshGraceHeal(tokenCtx())
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('fails open: an internal error never blocks the token endpoint', async () => {
    mockFindFirst.mockRejectedValueOnce(new Error('db down'))
    await expect(handleRefreshGraceHeal(tokenCtx())).resolves.toBeUndefined()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
