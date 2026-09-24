/**
 * /api/widget/search and /api/widget/kb-search read their query string
 * directly and are open to anonymous callers. A hand-typed or shared URL must
 * never fail the query they run: a NUL in a term or board slug (Postgres
 * rejects it in text) gets the empty result, and a `limit` that `LIMIT` would
 * reject (negative or fractional) falls back to the default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  listPublicPosts: vi.fn(),
  hybridSearch: vi.fn(),
  readable: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: unknown) => ({ options: opts }),
}))
vi.mock('@/lib/server/domains/settings/settings.widget', () => ({
  getWidgetConfig: async () => ({ enabled: true }),
}))
vi.mock('@/lib/server/domains/posts/post.public', () => ({
  listPublicPosts: hoisted.listPublicPosts,
}))
vi.mock('@/lib/server/functions/widget-auth', () => ({
  getWidgetSession: async () => null,
}))
vi.mock('@/lib/server/policy', () => ({
  ANONYMOUS_ACTOR: {
    principalId: null,
    role: null,
    principalType: 'anonymous',
    segmentIds: new Set(),
  },
}))
vi.mock('@/lib/server/domains/segments/segment-membership.service', () => ({
  segmentIdsForPrincipal: async () => new Set(),
}))
vi.mock('@/lib/server/functions/help-center', () => ({
  isPublicHelpCenterReadable: hoisted.readable,
}))
vi.mock('@/lib/server/domains/help-center/help-center-search.service', () => ({
  hybridSearch: hoisted.hybridSearch,
}))

type Handler = (args: { request: Request }) => Promise<Response>
function getHandler(route: unknown): Handler {
  return (route as { options: { server: { handlers: { GET: Handler } } } }).options.server.handlers
    .GET
}

const searchGET = getHandler((await import('../search')).Route)
const kbSearchGET = getHandler((await import('../kb-search')).Route)

const call = (handler: Handler, path: string) =>
  handler({ request: new Request(`https://feedback.acme.example${path}`) })

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.listPublicPosts.mockResolvedValue({ items: [], total: 0, hasMore: false })
  hoisted.hybridSearch.mockResolvedValue([])
  hoisted.readable.mockResolvedValue(true)
})

describe('/api/widget/search query values', () => {
  it.each([
    '?q=%00',
    '?q=a%00b',
    '?q=dark%20mode%00',
    '?q=ideas&board=a%00b',
    '?q=ideas&board=%00',
  ])('answers %s with an empty result and runs no query', async (query) => {
    const res = await call(searchGET, `/api/widget/search${query}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { posts: [] } })
    expect(hoisted.listPublicPosts).not.toHaveBeenCalled()
  })

  it.each([
    ['', 5],
    ['&limit=7', 7],
    ['&limit=20', 20],
    ['&limit=50', 20],
    ['&limit=0', 5],
    ['&limit=-5', 5],
    ['&limit=1.5', 5],
    ['&limit=abc', 5],
  ])('searches ?q=ideas%s with limit %i', async (limitQuery, limit) => {
    const res = await call(searchGET, `/api/widget/search?q=ideas${limitQuery}`)
    expect(res.status).toBe(200)
    expect(hoisted.listPublicPosts).toHaveBeenCalledTimes(1)
    expect(hoisted.listPublicPosts.mock.calls[0][0]).toMatchObject({ search: 'ideas', limit })
  })

  it('passes a board slug through as text', async () => {
    await call(searchGET, '/api/widget/search?q=ideas&board=feature-requests')
    expect(hoisted.listPublicPosts.mock.calls[0][0]).toMatchObject({
      search: 'ideas',
      boardSlug: 'feature-requests',
    })
  })
})

describe('/api/widget/kb-search query values', () => {
  it.each(['?q=%00', '?q=a%00b', '?q=setup%00'])(
    'answers %s with an empty result and runs no search',
    async (query) => {
      const res = await call(kbSearchGET, `/api/widget/kb-search${query}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ data: { articles: [] } })
      expect(hoisted.hybridSearch).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['', 10],
    ['&limit=3', 3],
    ['&limit=50', 20],
    ['&limit=-1', 10],
    ['&limit=2.5', 10],
    ['&limit=abc', 10],
  ])('searches ?q=setup%s with limit %i', async (limitQuery, limit) => {
    const res = await call(kbSearchGET, `/api/widget/kb-search?q=setup${limitQuery}`)
    expect(res.status).toBe(200)
    expect(hoisted.hybridSearch).toHaveBeenCalledWith('setup', limit)
  })
})
