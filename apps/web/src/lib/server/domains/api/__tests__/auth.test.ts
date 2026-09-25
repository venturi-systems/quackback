import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  requireApiKey,
  withApiKeyAuth,
  requiredRestScope,
  assertNoStatusChange,
  type AuthLevel,
} from '../auth'
import { API_KEY_SCOPES, LEGACY_API_KEY_SCOPES } from '@/lib/shared/api-key-scopes'
import type { ApiKey } from '@/lib/server/domains/api-keys'
import type { PrincipalId, ApiKeyId } from '@quackback/ids'
import { UnauthorizedError, ForbiddenError } from '@/lib/shared/errors'

// Mock the verifyApiKey function
vi.mock('@/lib/server/domains/api-keys/api-key.service', () => ({
  verifyApiKey: vi.fn(),
}))

// Mock the database — use vi.hoisted() so mockFindFirst is available when vi.mock factory runs
const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn().mockResolvedValue({ role: 'admin' }),
}))
// Creator-bound role capping is api-key-authority.ts (its own suite). Here it
// passes the key principal's stored role through unless a test caps it.
const { mockResolveApiKeyRole } = vi.hoisted(() => ({
  mockResolveApiKeyRole: vi.fn(async (_key: unknown, role: string | null | undefined) =>
    role === 'admin' || role === 'member' ? role : 'user'
  ),
}))
vi.mock('@/lib/server/domains/api-keys/api-key-authority', () => ({
  resolveApiKeyRole: (key: unknown, role: string | null | undefined) =>
    mockResolveApiKeyRole(key, role),
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      principal: {
        findFirst: mockFindFirst,
      },
    },
    select: () => ({ from: () => ({ limit: () => Promise.resolve([]) }) }),
  },
  principal: { id: 'id' },
  settings: { tierLimits: 'tier_limits' },
  eq: vi.fn(),
}))

describe('API Auth', () => {
  const mockApiKey: ApiKey = {
    id: 'apikey_01h455vb4pex5vsknk084sn02q' as ApiKeyId,
    name: 'Test Key',
    keyPrefix: 'qb_test',
    principalId: 'principal_01h455vb4pex5vsknk084sn02s' as PrincipalId,
    createdById: 'member_01h455vb4pex5vsknk084sn02r' as PrincipalId,
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    legacyBoundedAt: null,
    // A full-access key; "per-key scopes" below covers a key stored without scopes.
    scopes: [...API_KEY_SCOPES],
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('requireApiKey', () => {
    it('should return null when no Authorization header', async () => {
      const request = new Request('https://example.com/api', {
        method: 'GET',
      })

      const result = await requireApiKey(request)
      expect(result).toBeNull()
    })

    it('should return null when Authorization header is not Bearer', async () => {
      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          Authorization: 'Basic abc123',
        },
      })

      const result = await requireApiKey(request)
      expect(result).toBeNull()
    })

    it('should return null when API key is invalid', async () => {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue(null)

      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer qb_invalid_key',
        },
      })

      const result = await requireApiKey(request)
      expect(result).toBeNull()
    })

    it('should return auth context when API key is valid', async () => {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue(mockApiKey)

      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer qb_valid_key',
        },
      })

      const result = await requireApiKey(request)
      expect(result).toEqual({
        apiKey: mockApiKey,
        principalId: mockApiKey.principalId,
        role: 'admin',
        scopes: [...API_KEY_SCOPES],
        importMode: false,
      })
    })

    it('should handle Bearer token with extra whitespace', async () => {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue(mockApiKey)

      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer   qb_valid_key',
        },
      })

      const result = await requireApiKey(request)
      expect(result).not.toBeNull()
    })

    it('should handle case-insensitive Bearer prefix', async () => {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue(mockApiKey)

      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          Authorization: 'BEARER qb_valid_key',
        },
      })

      const result = await requireApiKey(request)
      expect(result).not.toBeNull()
    })
  })

  describe('withApiKeyAuth', () => {
    it('should throw UnauthorizedError when authentication fails', async () => {
      const request = new Request('https://example.com/api', {
        method: 'GET',
      })

      await expect(withApiKeyAuth(request, { role: 'team' })).rejects.toThrow(UnauthorizedError)
    })

    it('should include hint about Bearer format in error message', async () => {
      const request = new Request('https://example.com/api', {
        method: 'GET',
      })

      await expect(withApiKeyAuth(request, { role: 'team' })).rejects.toThrow('Bearer qb_xxx')
    })

    it('should return auth context when authentication succeeds with team role', async () => {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue(mockApiKey)

      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer qb_valid_key',
        },
      })

      const result = await withApiKeyAuth(request, { role: 'team' })

      expect(result).toEqual({
        apiKey: mockApiKey,
        principalId: mockApiKey.principalId,
        role: 'admin',
        scopes: [...API_KEY_SCOPES],
        importMode: false,
      })
    })

    it('should throw ForbiddenError when admin role required but member is not admin', async () => {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue(mockApiKey)

      mockFindFirst.mockResolvedValue({ role: 'member' })

      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer qb_valid_key',
        },
      })

      await expect(withApiKeyAuth(request, { role: 'admin' })).rejects.toThrow(ForbiddenError)
      await expect(withApiKeyAuth(request, { role: 'admin' })).rejects.toThrow(
        'Admin access required'
      )
    })

    it('should throw ForbiddenError when team role required but member is a portal user', async () => {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue(mockApiKey)

      mockFindFirst.mockResolvedValue({ role: 'user' })

      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer qb_valid_key',
        },
      })

      await expect(withApiKeyAuth(request, { role: 'team' })).rejects.toThrow(ForbiddenError)
      await expect(withApiKeyAuth(request, { role: 'team' })).rejects.toThrow(
        'Team member access required'
      )
    })

    it('should allow admin through for both team and admin roles', async () => {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue(mockApiKey)

      mockFindFirst.mockResolvedValue({ role: 'admin' })

      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer qb_valid_key',
        },
      })

      for (const role of ['team', 'admin'] as AuthLevel[]) {
        const result = await withApiKeyAuth(request, { role })
        expect(result).toBeDefined()
        expect(result.role).toBe('admin')
      }
    })

    it('caps the key at its creator\u2019s current role (team identity rule)', async () => {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue(mockApiKey)
      mockFindFirst.mockResolvedValue({ role: 'admin' })
      mockResolveApiKeyRole.mockResolvedValueOnce('user')

      const request = new Request('https://example.com/api', {
        method: 'GET',
        headers: { Authorization: 'Bearer qb_valid_key' },
      })

      await expect(withApiKeyAuth(request, { role: 'team' })).rejects.toThrow(
        'Team member access required'
      )
    })
  })

  describe('per-key scopes', () => {
    async function keyWith(scopes: string[] | null) {
      const { verifyApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      vi.mocked(verifyApiKey).mockResolvedValue({ ...mockApiKey, scopes } as ApiKey)
      mockFindFirst.mockResolvedValue({ role: 'admin' })
    }
    const req = (method: string, path: string) =>
      new Request(`https://example.com${path}`, {
        method,
        headers: { Authorization: 'Bearer qb_valid_key' },
      })

    it('lets a read-only key read', async () => {
      await keyWith(['read:feedback'])
      await expect(
        withApiKeyAuth(req('GET', '/api/v1/posts'), { role: 'team' })
      ).resolves.toBeDefined()
    })

    it('refuses a write to a read-only key', async () => {
      await keyWith(['read:feedback'])
      await expect(
        withApiKeyAuth(req('PATCH', '/api/v1/posts/post_1'), { role: 'team' })
      ).rejects.toThrow(/write:feedback/)
    })

    it('refuses administrator routes to a key without admin:workspace', async () => {
      await keyWith(['read:feedback', 'write:feedback'])
      await expect(
        withApiKeyAuth(req('GET', '/api/v1/webhooks'), { role: 'admin' })
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' })
    })

    it('reads only with a key stored without scopes, never full access (DEF-15)', async () => {
      await keyWith(null)
      const auth = await withApiKeyAuth(req('GET', '/api/v1/posts'), { role: 'team' })
      expect(auth.scopes).toEqual([...LEGACY_API_KEY_SCOPES])
      await expect(
        withApiKeyAuth(req('GET', '/api/v1/help-center/articles'), { role: 'team' })
      ).resolves.toBeDefined()
      await expect(
        withApiKeyAuth(req('PATCH', '/api/v1/posts/post_1'), { role: 'team' })
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' })
      await expect(
        withApiKeyAuth(req('DELETE', '/api/v1/webhooks/w1'), { role: 'admin' })
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' })
    })

    it('keeps every scope for a full-access key', async () => {
      await keyWith([...API_KEY_SCOPES])
      await expect(
        withApiKeyAuth(req('DELETE', '/api/v1/webhooks/w1'), { role: 'admin' })
      ).resolves.toBeDefined()
    })

    it('skips the method check when the caller enforces scopes itself (MCP)', async () => {
      await keyWith(['read:feedback'])
      await expect(
        withApiKeyAuth(req('POST', '/api/mcp'), { role: 'team', scope: null })
      ).resolves.toBeDefined()
    })
  })

  describe('requiredRestScope', () => {
    const req = (method: string, path: string) =>
      new Request(`https://example.com${path}`, { method })

    it('maps resource families and methods to scopes', () => {
      expect(requiredRestScope(req('GET', '/api/v1/posts'), 'team')).toBe('read:feedback')
      expect(requiredRestScope(req('POST', '/api/v1/posts'), 'team')).toBe('write:feedback')
      expect(requiredRestScope(req('GET', '/api/v1/help-center/articles'), 'team')).toBe(
        'read:article'
      )
      expect(requiredRestScope(req('PATCH', '/api/v1/help-center/articles/a'), 'team')).toBe(
        'write:article'
      )
      expect(requiredRestScope(req('GET', '/api/v1/conversations'), 'team')).toBe('read:chat')
      expect(requiredRestScope(req('POST', '/api/v1/changelog'), 'team')).toBe('write:changelog')
      expect(requiredRestScope(req('GET', '/api/v1/changelog'), 'team')).toBe('read:feedback')
      expect(requiredRestScope(req('GET', '/api/v1/webhooks'), 'admin')).toBe('admin:workspace')
    })
  })

  describe('assertNoStatusChange', () => {
    it('refuses any status in a request body', () => {
      expect(() => assertNoStatusChange('status_done')).toThrow(ForbiddenError)
      expect(() => assertNoStatusChange('status_done')).toThrow(/cannot change a status/)
    })

    it('allows a body without a status', () => {
      expect(() => assertNoStatusChange(undefined)).not.toThrow()
      expect(() => assertNoStatusChange(null)).not.toThrow()
    })
  })
})
