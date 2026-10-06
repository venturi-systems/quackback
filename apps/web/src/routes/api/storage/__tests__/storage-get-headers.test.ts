/**
 * Proxied storage responses carry caller-influenced Content-Types (the upload
 * path stores the declared multipart type), so every proxy response must send
 * X-Content-Type-Options: nosniff — including the in-memory cache hit and the
 * ?email=1 forced-proxy path, which is reachable on every deployment
 * regardless of S3_PROXY.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = { s3Proxy: false }
const policy = vi.hoisted(() => ({ access: vi.fn(), branding: vi.fn() }))
vi.mock('@/lib/server/functions/portal-access', () => ({
  resolvePortalAccessForRequest: policy.access,
}))
vi.mock('@/lib/server/db', () => ({ db: { query: { settings: { findFirst: policy.branding } } } }))

const getS3Object = vi.fn(async (_key: string) => ({
  body: new Blob([new Uint8Array([0x47, 0x49, 0x46])]).stream(),
  contentType: 'image/gif',
}))

vi.mock('@/lib/server/config', () => ({ config: mockConfig }))
vi.mock('@/lib/server/storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
  getS3Object,
  generatePresignedGetUrl: vi.fn(async () => 'https://s3.example.com/presigned'),
}))

const { handleStorageGet } = await import('../$')

const get = (path: string) =>
  handleStorageGet({ request: new Request(`https://app.example.com${path}`) })

beforeEach(() => {
  mockConfig.s3Proxy = false
  getS3Object.mockClear()
  policy.access.mockResolvedValue({ granted: true, reason: 'invite' })
  policy.branding.mockResolvedValue({
    logoKey: 'logos/current.gif',
    faviconKey: null,
    headerLogoKey: null,
  })
})

describe('handleStorageGet — proxy response headers', () => {
  it('sends nosniff on proxied responses (S3_PROXY=true)', async () => {
    mockConfig.s3Proxy = true
    const res = await get('/api/storage/widget-images/fresh-proxy.gif')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('sends nosniff on the in-memory cache hit', async () => {
    mockConfig.s3Proxy = true
    await get('/api/storage/widget-images/cached.gif')
    const res = await get('/api/storage/widget-images/cached.gif')
    expect(getS3Object).toHaveBeenCalledTimes(1)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('sends nosniff on the ?email=1 forced-proxy path even without S3_PROXY', async () => {
    const res = await get('/api/storage/widget-images/email-embed.gif?email=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('still redirects to the presigned URL when not proxying', async () => {
    const res = await get('/api/storage/logos/current.gif')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://s3.example.com/presigned')
  })
})

describe('FB-019 private storage admission', () => {
  it.each(['', '?email=1'])('denies private media before reads with %s', async (query) => {
    policy.access.mockResolvedValue({ granted: false, reason: 'unauthenticated' })
    const response = await get('/api/storage/portal-images/private.gif' + query)
    expect(response.status).toBe(403)
    expect(getS3Object).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
  it('streams admitted media without reusable signed redirects or shared caches', async () => {
    const response = await get('/api/storage/portal-images/approved.gif')
    expect(response.status).toBe(200)
    expect(response.headers.get('Location')).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
  it('rechecks approval before a cached object and denies revoked access', async () => {
    const path = '/api/storage/portal-images/revoked.gif?email=1'
    expect((await get(path)).status).toBe(200)
    policy.access.mockResolvedValue({ granted: false, reason: 'unauthorized' })
    expect((await get(path)).status).toBe(403)
    expect(getS3Object).toHaveBeenCalledTimes(1)
  })
  it('exempts exact current brand keys without accepting neighboring keys', async () => {
    policy.access.mockResolvedValue({ granted: false, reason: 'unauthenticated' })
    expect((await get('/api/storage/logos/current.gif')).status).toBe(302)
    expect((await get('/api/storage/logos/current.gif?email=1')).status).toBe(200)
    expect((await get('/api/storage/logos/current.gif-copy')).status).toBe(403)
  })
  it('fails closed on policy outage and handles malformed encoded keys', async () => {
    policy.branding.mockRejectedValue(new Error('Database unavailable'))
    expect((await get('/api/storage/portal-images/private.gif')).status).toBe(403)
    expect((await get('/api/storage/%ZZ')).status).toBe(400)
    expect(getS3Object).not.toHaveBeenCalled()
  })
})
