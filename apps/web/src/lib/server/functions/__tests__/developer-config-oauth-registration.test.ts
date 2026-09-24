/**
 * fetchDeveloperConfig tells the admin MCP setup guide whether OAuth client
 * registration without an account is open, so the guide never recommends an
 * OAuth config the server would refuse to register. This fork never allows
 * it (auth/oauth-client-defaults.ts, landing-page#2309), so the answer is
 * always closed, whatever the environment says. The endpoint stays admin-only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tanstack/react-start', () => ({
  // The exported server fn IS the raw handler, so tests call it directly.
  createServerFn: () => {
    const chain = {
      validator: () => chain,
      handler: (fn: unknown) => fn,
    }
    return chain
  },
}))

const hoisted = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetDeveloperConfig: vi.fn(),
}))

vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: hoisted.mockRequireAuth,
}))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getPortalConfig: vi.fn(),
  getPublicPortalConfig: vi.fn(),
  getPublicAuthConfig: vi.fn(),
  updatePortalConfig: vi.fn(),
  getDeveloperConfig: hoisted.mockGetDeveloperConfig,
  updateDeveloperConfig: vi.fn(),
}))
vi.mock('@/lib/server/domains/settings/settings.media', () => ({}))
vi.mock('@/lib/server/storage/s3', () => ({ getPublicUrlOrNull: vi.fn() }))
vi.mock('@/lib/server/audit/log', () => ({ actorFromAuth: vi.fn(), recordAuditEvent: vi.fn() }))
vi.mock('@/lib/server/auth/session', () => ({ getSession: vi.fn() }))
vi.mock('@/lib/server/db', () => ({
  db: {},
  principal: {},
  user: {},
  invitation: {},
  account: {},
  eq: vi.fn(),
  ne: vi.fn(),
  and: vi.fn(),
}))

const { fetchDeveloperConfig } = await import('../settings')
const fetchDeveloperConfigHandler = fetchDeveloperConfig as unknown as () => Promise<{
  mcpEnabled: boolean
  oauthClientRegistrationOpen: boolean
}>

const KEY = 'OAUTH_ALLOW_UNAUTHENTICATED_CLIENT_REGISTRATION'
const original = process.env[KEY]

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.mockRequireAuth.mockResolvedValue({ principal: { role: 'admin' } })
  hoisted.mockGetDeveloperConfig.mockResolvedValue({ mcpEnabled: true })
})

afterEach(() => {
  if (original === undefined) delete process.env[KEY]
  else process.env[KEY] = original
})

describe('fetchDeveloperConfig: OAuth client registration status', () => {
  it('reports registration closed by default', async () => {
    delete process.env[KEY]
    await expect(fetchDeveloperConfigHandler()).resolves.toEqual({
      mcpEnabled: true,
      oauthClientRegistrationOpen: false,
    })
  })

  it('reports registration closed even when the retired switch is set', async () => {
    process.env[KEY] = 'true'
    const result = await fetchDeveloperConfigHandler()
    expect(result.oauthClientRegistrationOpen).toBe(false)
  })

  it('stays admin-only', async () => {
    hoisted.mockRequireAuth.mockRejectedValue(
      new Error('Access denied: Requires [admin], got member')
    )
    await expect(fetchDeveloperConfigHandler()).rejects.toThrow('Access denied')
    expect(hoisted.mockRequireAuth).toHaveBeenCalledWith({ roles: ['admin'] })
    expect(hoisted.mockGetDeveloperConfig).not.toHaveBeenCalled()
  })
})
