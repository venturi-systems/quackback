/**
 * getBootstrapData is a public `/_serverFn` endpoint (the root route calls it
 * on every navigation), so it must strip server-only policy and secrets at the
 * RPC boundary: the portal access allowlist (allowedDomains, widgetSignIn,
 * allowedSegmentIds) and the widget HMAC secret. It also reports a team role
 * held by an anonymous principal as a portal user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  policyManagedSettings: [] as string[],
  tenant: null as null | Record<string, unknown>,
  cookie: '' as string,
  principal: null as null | { type: string; role: string },
}))

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = { validator: () => chain, handler: (fn: unknown) => fn }
    return chain
  },
  createServerOnlyFn: <T>(fn: T) => fn,
}))
vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers(hoisted.cookie ? { cookie: hoisted.cookie } : {}),
}))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getTenantSettings: async () => hoisted.tenant,
}))
vi.mock('@/lib/server/auth/registered-providers', () => ({
  getRegisteredAuthProviders: async () => ['google', 'github'],
}))
vi.mock('@/lib/server/config', () => ({
  config: {
    baseUrl: 'https://feedback.acme.example',
    get policyManagedSettings() {
      return hoisted.policyManagedSettings
    },
  },
}))
vi.mock('@/lib/server/auth/index', () => ({
  auth: {
    api: {
      getSession: async () => ({
        session: {
          id: 'session_1',
          expiresAt: new Date(),
          token: 't',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        user: {
          id: 'user_1',
          name: 'Visitor',
          email: 'visitor@acme.example',
          emailVerified: false,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    },
  },
}))
vi.mock('@/lib/server/db', () => ({
  db: { query: { principal: { findFirst: async () => hoisted.principal } } },
  principal: { userId: 'userId' },
  eq: vi.fn(),
}))
vi.mock('@/lib/server/redis', () => ({
  cacheGet: async () => null,
  cacheSet: async () => undefined,
  CACHE_KEYS: { PRINCIPAL_BY_USER: (id: string) => `principal:user:${id}` },
}))
vi.mock('@/lib/server/telemetry', () => ({ startTelemetry: vi.fn() }))

const { getBootstrapData } = (await import('../bootstrap')) as unknown as {
  getBootstrapData: () => Promise<{
    settings: Record<string, unknown> | null
    userRole: string | null
    managedFieldPaths: string[]
  }>
}

const ACCESS = {
  visibility: 'authenticated',
  allowedDomains: ['allowlisted.example'],
  widgetSignIn: true,
  allowedSegmentIds: ['segment_1'],
}

beforeEach(() => {
  hoisted.cookie = ''
  hoisted.principal = null
  hoisted.tenant = {
    name: 'Acme',
    slug: 'acme',
    portalConfig: { features: { allowAnonymous: false }, access: ACCESS },
    settings: {
      id: 'workspace_1',
      name: 'Acme',
      widgetSecret: 'wgt_must_not_leak',
      portalConfig: JSON.stringify({ features: { allowAnonymous: false }, access: ACCESS }),
      setupState: JSON.stringify({
        version: 1,
        steps: { core: true, workspace: true, boards: true },
      }),
    },
    managedFieldPaths: [],
  }
  hoisted.policyManagedSettings = []
})

describe('getBootstrapData RPC boundary', () => {
  it('never returns the widget secret or the portal access allowlist', async () => {
    const data = await getBootstrapData()
    const wire = JSON.stringify(data)
    expect(wire).not.toContain('wgt_must_not_leak')
    expect(wire).not.toContain('allowlisted.example')
    expect(wire).not.toContain('segment_1')
    const settings = data.settings as {
      portalConfig: { access: unknown }
      settings: Record<string, unknown>
    }
    expect(settings.portalConfig.access).toEqual({ visibility: 'authenticated' })
    expect(settings.settings).not.toHaveProperty('widgetSecret')
    expect(JSON.parse(settings.settings.portalConfig as string).access).toEqual({
      visibility: 'authenticated',
    })
    // Fields the client legitimately needs survive.
    expect(settings.settings.setupState).toBeTruthy()
  })

  it('reports a team role held by an anonymous principal as a portal user', async () => {
    hoisted.cookie = 'better-auth.session_token=abc'
    hoisted.principal = { type: 'anonymous', role: 'admin' }
    const data = await getBootstrapData()
    expect(data.userRole).toBe('user')
  })

  it('reports a human admin as admin', async () => {
    hoisted.cookie = 'better-auth.session_token=abc'
    hoisted.principal = { type: 'user', role: 'admin' }
    const data = await getBootstrapData()
    expect(data.userRole).toBe('admin')
  })
})

describe('getBootstrapData managed settings', () => {
  it('adds POLICY_MANAGED_SETTINGS paths to the config-file list without duplicates', async () => {
    ;(hoisted.tenant as { managedFieldPaths: string[] }).managedFieldPaths = [
      'workspace.name',
      'auth.oauth',
    ]
    hoisted.policyManagedSettings = ['auth.oauth', 'boards.feature-requests.access']
    const data = await getBootstrapData()
    expect(data.managedFieldPaths).toEqual([
      'workspace.name',
      'auth.oauth',
      'boards.feature-requests.access',
    ])
  })
})
