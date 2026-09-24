/**
 * Public help-center reads (and article feedback) are portal content. They
 * are served only when the help center is switched on (the `helpCenter`
 * feature flag AND helpCenterConfig.enabled) AND the caller passes the same
 * portal-access gate as every other portal read. A denied caller gets the
 * empty / not-found shape, never content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateId } from '@quackback/ids'

const hoisted = vi.hoisted(() => ({
  tenant: null as null | Record<string, unknown>,
  access: { granted: true, reason: 'public' } as { granted: boolean; reason: string },
  service: {
    listPublicCategories: vi.fn(),
    listPublicArticles: vi.fn(),
    listPublicArticlesForCategory: vi.fn(),
    listPublicCategoryEditors: vi.fn(),
    getPublicArticleBySlug: vi.fn(),
    recordArticleFeedback: vi.fn(),
  },
  getPublicCategoryBySlug: vi.fn(),
  hybridSearch: vi.fn(),
  // The validator each handler was registered with. Handlers run unvalidated.
  inputs: new Map<unknown, { safeParse(value: unknown): { success: boolean } } | undefined>(),
}))

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let input: { safeParse(value: unknown): { success: boolean } } | undefined
    const chain = {
      validator(schema: { safeParse(value: unknown): { success: boolean } }) {
        input = schema
        return chain
      },
      handler(fn: unknown) {
        hoisted.inputs.set(fn, input)
        return fn
      },
    }
    return chain
  },
  createServerOnlyFn: <T>(fn: T) => fn,
}))
vi.mock('../auth-helpers', () => ({
  requireAuth: vi.fn(),
  getOptionalAuth: vi.fn(async () => null),
}))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getTenantSettings: async () => hoisted.tenant,
}))
vi.mock('../portal-access', () => ({
  resolvePortalAccessForRequest: async () => hoisted.access,
}))
vi.mock('@/lib/server/domains/help-center/help-center.service', () => hoisted.service)
vi.mock('@/lib/server/domains/help-center/help-center.category.service', () => ({
  getPublicCategoryBySlug: hoisted.getPublicCategoryBySlug,
}))
vi.mock('@/lib/server/domains/help-center/help-center-search.service', () => ({
  hybridSearch: hoisted.hybridSearch,
}))
vi.mock('@/lib/server/sanitize-tiptap', () => ({ sanitizeTiptapContent: (v: unknown) => v }))

const hc = await import('../help-center')
type AnyFn = (args?: { data: Record<string, unknown> }) => Promise<unknown>
const fn = (name: keyof typeof hc) => hc[name] as unknown as AnyFn

const NOW = new Date('2026-09-01T00:00:00Z')
const ARTICLE = {
  id: 'article_1',
  slug: 'getting-started',
  title: 'Getting started',
  createdAt: NOW,
  updatedAt: NOW,
  publishedAt: NOW,
  deletedAt: null,
  helpfulCount: 3,
  notHelpfulCount: 1,
}
const CATEGORY = { id: 'category_1', slug: 'basics', createdAt: NOW, updatedAt: NOW }

function enabledTenant() {
  return { featureFlags: { helpCenter: true }, helpCenterConfig: { enabled: true } }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.tenant = enabledTenant()
  hoisted.access = { granted: true, reason: 'public' }
  hoisted.service.listPublicCategories.mockResolvedValue([CATEGORY])
  hoisted.service.listPublicArticles.mockResolvedValue({
    items: [ARTICLE],
    nextCursor: null,
    hasMore: false,
  })
  hoisted.service.listPublicArticlesForCategory.mockResolvedValue([ARTICLE])
  hoisted.service.listPublicCategoryEditors.mockResolvedValue({ category_1: [] })
  hoisted.service.getPublicArticleBySlug.mockResolvedValue(ARTICLE)
  hoisted.getPublicCategoryBySlug.mockResolvedValue(CATEGORY)
  hoisted.hybridSearch.mockResolvedValue([{ id: 'article_1' }])
})

const DENIED_STATES: Array<[string, () => void]> = [
  [
    'a cookie-less caller on a gated portal',
    () => {
      hoisted.access = { granted: false, reason: 'unauthenticated' }
    },
  ],
  [
    'the helpCenter feature flag off',
    () => {
      hoisted.tenant = { ...enabledTenant(), featureFlags: { helpCenter: false } }
    },
  ],
  [
    'helpCenterConfig.enabled false',
    () => {
      hoisted.tenant = { ...enabledTenant(), helpCenterConfig: { enabled: false } }
    },
  ],
  [
    'no settings row',
    () => {
      hoisted.tenant = null
    },
  ],
]

describe.each(DENIED_STATES)('help center public reads with %s', (_label, arrange) => {
  beforeEach(() => arrange())

  it('lists no categories, articles, editors or search results', async () => {
    expect(await fn('listPublicCategoriesFn')({ data: {} })).toEqual([])
    expect(await fn('listPublicArticlesFn')({ data: {} })).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    })
    expect(
      await fn('listPublicArticlesForCategoryFn')({ data: { categoryId: 'category_1' } })
    ).toEqual([])
    expect(await fn('listPublicCategoryEditorsFn')({ data: {} })).toEqual({})
    expect(await fn('searchPublicArticlesFn')({ data: { query: 'start' } })).toEqual([])
    expect(hoisted.service.listPublicCategories).not.toHaveBeenCalled()
    expect(hoisted.service.listPublicArticles).not.toHaveBeenCalled()
    expect(hoisted.hybridSearch).not.toHaveBeenCalled()
  })

  it('returns not-found for slug lookups and refuses article feedback', async () => {
    await expect(
      fn('getPublicCategoryBySlugFn')({ data: { slug: 'basics' } })
    ).rejects.toMatchObject({ code: 'HELP_CENTER_NOT_FOUND' })
    await expect(
      fn('getPublicArticleBySlugFn')({ data: { slug: 'getting-started' } })
    ).rejects.toMatchObject({ code: 'HELP_CENTER_NOT_FOUND' })
    await expect(
      fn('recordArticleFeedbackFn')({ data: { articleId: 'article_1', helpful: true } })
    ).rejects.toMatchObject({ code: 'HELP_CENTER_NOT_FOUND' })
    expect(hoisted.service.getPublicArticleBySlug).not.toHaveBeenCalled()
    expect(hoisted.service.recordArticleFeedback).not.toHaveBeenCalled()
  })
})

describe('help center public reads fail closed', () => {
  it('denies when the portal-access resolver throws', async () => {
    const pa = await import('../portal-access')
    vi.spyOn(pa, 'resolvePortalAccessForRequest').mockRejectedValueOnce(new Error('db down'))
    expect(await fn('listPublicCategoriesFn')({ data: {} })).toEqual([])
  })
})

describe('help center public reads when enabled and the caller is granted', () => {
  it.each(['public', 'authenticated', 'team'])('serves content for a %s grant', async (reason) => {
    hoisted.access = { granted: true, reason }
    expect(await fn('listPublicCategoriesFn')({ data: {} })).toHaveLength(1)
    const article = (await fn('getPublicArticleBySlugFn')({
      data: { slug: 'getting-started' },
    })) as Record<string, unknown>
    expect(article.slug).toBe('getting-started')
    // Vote tallies stay private on the public article shape.
    expect(article).not.toHaveProperty('helpfulCount')
    expect(await fn('searchPublicArticlesFn')({ data: { query: 'start' } })).toHaveLength(1)
    await fn('recordArticleFeedbackFn')({ data: { articleId: 'article_1', helpful: true } })
    expect(hoisted.service.recordArticleFeedback).toHaveBeenCalledTimes(1)
  })
})

describe('public help-center read inputs (DEF-45)', () => {
  // Reachable without signing in. The category and article id columns take
  // only a TypeID of their entity, and Postgres rejects a NUL in the search
  // text or a slug, so each validator refuses those before any query runs.
  const CATEGORY_ID = generateId('category')
  const ARTICLE_ID = generateId('article')

  function inputOf(name: keyof typeof hc) {
    const input = hoisted.inputs.get(hc[name])
    if (!input) throw new Error(`${String(name)} has no validator`)
    return input
  }

  it.each<[name: keyof typeof hc, accepted: unknown[], refused: unknown[]]>([
    [
      'listPublicArticlesFn',
      [{}, { categoryId: CATEGORY_ID, search: 'reset password', cursor: ARTICLE_ID, limit: 20 }],
      [
        { categoryId: 'category_1' },
        { categoryId: ARTICLE_ID },
        { cursor: 'article_1' },
        { cursor: CATEGORY_ID },
        { search: 'reset\u0000password' },
      ],
    ],
    [
      'listPublicArticlesForCategoryFn',
      [{ categoryId: CATEGORY_ID }],
      [{ categoryId: 'category_1' }, { categoryId: ARTICLE_ID }, {}],
    ],
    ['getPublicCategoryBySlugFn', [{ slug: 'basics' }], [{ slug: 'bas\u0000ics' }, { slug: '' }]],
    [
      'getPublicArticleBySlugFn',
      [{ slug: 'getting-started' }],
      [{ slug: 'getting\u0000started' }, { slug: '' }],
    ],
    [
      'recordArticleFeedbackFn',
      [{ articleId: ARTICLE_ID, helpful: true }],
      [
        { articleId: 'article_1', helpful: true },
        { articleId: CATEGORY_ID, helpful: false },
      ],
    ],
  ])('%s takes what the app sends and refuses the rest', (name, accepted, refused) => {
    const input = inputOf(name)
    for (const value of accepted) {
      expect(input.safeParse(value).success, JSON.stringify(value)).toBe(true)
    }
    for (const value of refused) {
      expect(input.safeParse(value).success, JSON.stringify(value)).toBe(false)
    }
  })
})

describe('public help-center search input (DEF-45)', () => {
  // The query feeds a full-text search, and Postgres rejects a NUL in text, so
  // a hand-made call with one fails at the validator instead of the query.
  it('takes a search term and refuses a NUL', () => {
    const input = hoisted.inputs.get(hc.searchPublicArticlesFn)
    if (!input) throw new Error('searchPublicArticlesFn has no validator')
    expect(input.safeParse({ query: 'getting started', limit: 5 }).success).toBe(true)
    expect(input.safeParse({ query: 'getting\u0000started' }).success).toBe(false)
    expect(input.safeParse({ query: '\u0000' }).success).toBe(false)
    expect(input.safeParse({ query: '' }).success).toBe(false)
  })
})
