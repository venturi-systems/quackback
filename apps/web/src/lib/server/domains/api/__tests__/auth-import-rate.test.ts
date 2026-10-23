import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiKey } from '@/lib/server/domains/api-keys'
import { generateId } from '@quackback/ids'
import { API_KEY_SCOPES } from '@/lib/shared/api-key-scopes'
import { OSS_TIER_LIMITS } from '@/lib/server/domains/settings/tier-limits.types'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  principal: vi.fn(),
  role: vi.fn(),
  limits: vi.fn(),
}))
vi.mock('@/lib/server/domains/api-keys/api-key.service', () => ({
  verifyApiKey: (token: string) => mocks.verify(token),
}))
vi.mock('@/lib/server/domains/api-keys/api-key-authority', () => ({
  resolveApiKeyRole: (key: unknown, role: string | null | undefined) => mocks.role(key, role),
}))
vi.mock('@/lib/server/domains/principals/team-identity', () => ({
  resolveTeamRole: (principal: unknown) => mocks.role(principal),
}))
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: () => mocks.limits(),
}))
vi.mock('@/lib/server/db', () => ({
  db: {
    query: { principal: { findFirst: mocks.principal } },
    select: () => ({
      from: () => ({ limit: async () => [{ tierLimits: JSON.stringify(await mocks.limits()) }] }),
    }),
  },
  settings: { tierLimits: 'tier_limits' },
  principal: { id: 'id' },
  eq: vi.fn(),
}))

const key: ApiKey = {
  id: generateId('api_key'),
  name: 'Synthetic rate test',
  keyPrefix: 'qb_test',
  principalId: generateId('principal'),
  createdById: generateId('principal'),
  createdAt: new Date(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  legacyBoundedAt: null,
  scopes: [...API_KEY_SCOPES],
}

let caseNumber = 50
let clientIp = ''
const request = (authorization: string | null = 'Bearer qb_synthetic') => {
  const headers = new Headers({ 'x-import-mode': 'true', 'cf-connecting-ip': clientIp })
  if (authorization !== null) headers.set('authorization', authorization)
  return new Request('https://example.com/api/v1/posts', { method: 'POST', headers })
}

beforeEach(() => {
  clientIp = `192.0.2.${caseNumber++}`
  vi.clearAllMocks()
  mocks.limits.mockResolvedValue(OSS_TIER_LIMITS)
  mocks.verify.mockResolvedValue(key)
  mocks.principal.mockResolvedValue({ role: 'admin' })
  mocks.role.mockResolvedValue('admin')
})

describe('import rate authorization at the actual API boundary', () => {
  it('does not elevate invalid-key attempts or continue credential lookup past the normal budget', async () => {
    mocks.verify.mockResolvedValue(null)
    const { withApiKeyAuth } = await import('../auth')
    for (let i = 0; i < 100; i++) {
      await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
        statusCode: 401,
      })
    }
    await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(mocks.verify).toHaveBeenCalledTimes(100)
    expect(mocks.principal).not.toHaveBeenCalled()
  })

  it('does not elevate a missing authorization header', async () => {
    const { withApiKeyAuth } = await import('../auth')
    for (let i = 0; i < 100; i++) {
      await expect(withApiKeyAuth(request(null), { role: 'team' })).rejects.toMatchObject({
        statusCode: 401,
      })
    }
    await expect(withApiKeyAuth(request(null), { role: 'team' })).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('reserves capacity before concurrent invalid credential lookups', async () => {
    mocks.verify.mockResolvedValue(null)
    const { withApiKeyAuth } = await import('../auth')
    const results = await Promise.allSettled(
      Array.from({ length: 101 }, () => withApiKeyAuth(request(), { role: 'team' }))
    )
    expect(
      results.filter((result) => result.status === 'rejected' && result.reason?.statusCode === 401)
    ).toHaveLength(100)
    expect(
      results.filter((result) => result.status === 'rejected' && result.reason?.statusCode === 429)
    ).toHaveLength(1)
    expect(mocks.verify).toHaveBeenCalledTimes(100)
  })

  it('keeps a valid non-administrator on the normal budget despite the import header', async () => {
    mocks.role.mockResolvedValue('member')
    const { withApiKeyAuth } = await import('../auth')
    for (let i = 0; i < 100; i++) {
      await expect(withApiKeyAuth(request(), { role: 'team' })).resolves.toMatchObject({
        importMode: false,
      })
    }
    await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(mocks.verify).toHaveBeenCalledTimes(100)
  })

  it('does not elevate an administrator key without the required route scope', async () => {
    mocks.verify.mockResolvedValue({ ...key, scopes: ['read:feedback'] })
    const { withApiKeyAuth } = await import('../auth')
    for (let i = 0; i < 100; i++) {
      await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
        statusCode: 403,
      })
    }
    await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(mocks.verify).toHaveBeenCalledTimes(100)
  })

  it('admits ten concurrent authorized administrator imports', async () => {
    const { withApiKeyAuth, requireApiKey } = await import('../auth')
    await expect(requireApiKey(request())).resolves.toMatchObject({ role: 'admin' })
    mocks.verify.mockClear()
    const results = await Promise.all(
      Array.from({ length: 10 }, () => withApiKeyAuth(request(), { role: 'team' }))
    )
    expect(results.every((result) => result.importMode)).toBe(true)
    expect(mocks.verify).toHaveBeenCalledTimes(10)
  })

  it('rechecks the current role after loading the authority module', async () => {
    const { withApiKeyAuth } = await import('../auth')
    await expect(withApiKeyAuth(request(), { role: 'admin' })).resolves.toMatchObject({
      importMode: true,
    })
    mocks.role.mockResolvedValue('member')
    await expect(withApiKeyAuth(request(), { role: 'admin' })).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('revalidates the key on every request after a successful import', async () => {
    const { withApiKeyAuth } = await import('../auth')
    await expect(withApiKeyAuth(request(), { role: 'team' })).resolves.toMatchObject({
      importMode: true,
    })
    mocks.verify.mockResolvedValue(null)
    await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
      statusCode: 401,
    })
    expect(mocks.verify).toHaveBeenCalledTimes(2)
  })

  it('preserves 2000 valid administrator imports and bounds lookups after that budget is spent', async () => {
    const { withApiKeyAuth, requireApiKey } = await import('../auth')
    // Warm the mocked lazy authority import once before exercising concurrency.
    await expect(requireApiKey(request())).resolves.toMatchObject({ role: 'admin' })
    mocks.verify.mockClear()
    for (let batch = 0; batch < 200; batch++) {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => withApiKeyAuth(request(), { role: 'team' }))
      )
      expect(results.every((result) => result.importMode)).toBe(true)
    }
    for (let i = 0; i < 100; i++) {
      await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
        statusCode: 429,
      })
    }
    expect(mocks.verify).toHaveBeenCalledTimes(2100)
    await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(mocks.verify).toHaveBeenCalledTimes(2100)
  })

  it('preserves the configured normal tier and the existing minimum import budget', async () => {
    mocks.limits.mockResolvedValue({ ...OSS_TIER_LIMITS, apiRequestsPerMinute: 2 })
    const { withApiKeyAuth } = await import('../auth')
    for (let i = 0; i < 2000; i++) {
      await expect(withApiKeyAuth(request(), { role: 'team' })).resolves.toMatchObject({
        importMode: true,
      })
    }
    await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
      statusCode: 429,
    })
    await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(mocks.verify).toHaveBeenCalledTimes(2002)
    await expect(withApiKeyAuth(request(), { role: 'team' })).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(mocks.verify).toHaveBeenCalledTimes(2002)
  })
})
