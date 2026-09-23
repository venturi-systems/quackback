/**
 * /hc/sitemap.xml is fetched anonymously by crawlers. It publishes article
 * URLs only when the help center is enabled (flag + config) AND the portal is
 * public, mirroring /sitemap.xml's empty urlset for non-public portals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  flag: true,
  tenant: null as null | Record<string, unknown>,
  listPublicArticles: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: unknown) => ({ options: opts }),
}))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  isFeatureEnabled: async () => hoisted.flag,
  getTenantSettings: async () => hoisted.tenant,
}))
vi.mock('@/lib/server/domains/help-center/help-center.service', () => ({
  listPublicCategories: async () => [{ slug: 'basics', updatedAt: new Date('2026-09-01') }],
  listPublicArticles: hoisted.listPublicArticles,
}))

const { Route } = await import('../sitemap[.]xml')
type Handler = (args: { request: Request }) => Promise<Response>
const GET = (Route as unknown as { options: { server: { handlers: { GET: Handler } } } }).options
  .server.handlers.GET

const request = () => new Request('https://feedback.acme.example/hc/sitemap.xml')

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.flag = true
  hoisted.tenant = {
    helpCenterConfig: { enabled: true },
    portalConfig: { access: { visibility: 'public' } },
  }
  hoisted.listPublicArticles.mockResolvedValue({
    items: [
      {
        slug: 'getting-started',
        updatedAt: new Date('2026-09-01'),
        category: { slug: 'basics' },
      },
    ],
  })
})

describe('/hc/sitemap.xml gate', () => {
  it('404s when the feature flag is off', async () => {
    hoisted.flag = false
    expect((await GET({ request: request() })).status).toBe(404)
  })

  it('404s when helpCenterConfig.enabled is false', async () => {
    hoisted.tenant = { ...hoisted.tenant, helpCenterConfig: { enabled: false } }
    expect((await GET({ request: request() })).status).toBe(404)
    expect(hoisted.listPublicArticles).not.toHaveBeenCalled()
  })

  it.each(['authenticated', 'private'])(
    'publishes no article URLs when the portal is %s',
    async (visibility) => {
      hoisted.tenant = { ...hoisted.tenant, portalConfig: { access: { visibility } } }
      const res = await GET({ request: request() })
      const body = await res.text()
      expect(body).not.toContain('getting-started')
      expect(hoisted.listPublicArticles).not.toHaveBeenCalled()
    }
  )

  it('lists article URLs for an enabled help center on a public portal', async () => {
    const res = await GET({ request: request() })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('getting-started')
  })
})
