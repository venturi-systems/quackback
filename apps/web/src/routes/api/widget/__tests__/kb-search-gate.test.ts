/**
 * /api/widget/kb-search serves help-center article text with a wildcard CORS
 * header, so it applies the same gate as the portal help-center reads:
 * helpCenter flag + helpCenterConfig.enabled + portal access for the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  readable: vi.fn(),
  hybridSearch: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: unknown) => ({ options: opts }),
}))
vi.mock('@/lib/server/functions/help-center', () => ({
  isPublicHelpCenterReadable: hoisted.readable,
}))
vi.mock('@/lib/server/domains/help-center/help-center-search.service', () => ({
  hybridSearch: hoisted.hybridSearch,
}))

const { Route } = await import('../kb-search')
type Handler = (args: { request: Request }) => Promise<Response>
const GET = (Route as unknown as { options: { server: { handlers: { GET: Handler } } } }).options
  .server.handlers.GET

const request = () => new Request('https://feedback.acme.example/api/widget/kb-search?q=start')

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.hybridSearch.mockResolvedValue([
    {
      id: 'article_1',
      slug: 'getting-started',
      title: 'Getting started',
      content: 'Body',
      categoryId: 'category_1',
      categorySlug: 'basics',
      categoryName: 'Basics',
    },
  ])
})

describe('/api/widget/kb-search gate', () => {
  it('404s without searching when the help center is not readable for the caller', async () => {
    hoisted.readable.mockResolvedValue(false)
    const res = await GET({ request: request() })
    expect(res.status).toBe(404)
    expect(hoisted.hybridSearch).not.toHaveBeenCalled()
  })

  it('searches when the help center is readable', async () => {
    hoisted.readable.mockResolvedValue(true)
    const res = await GET({ request: request() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { articles: Array<{ slug: string }> } }
    expect(body.data.articles.map((a) => a.slug)).toEqual(['getting-started'])
  })
})
