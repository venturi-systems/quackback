/**
 * Help Center API Integration Tests
 *
 * Run with: API_KEY=qb_xxx bun run test help-center-api
 * Member-access tests also require: MEMBER_API_KEY=qb_xxx (a key with role='member')
 * To skip: SKIP_INTEGRATION=true bun run test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  SKIP_INTEGRATION,
  API_KEY,
  MEMBER_API_KEY,
  api,
  apiWith,
  createTestState,
  setUpIntegrationSuite,
  cleanupCreatedResources,
} from './api-integration.helpers'

interface HCTestState {
  testCategoryId: string | null
  testArticleId: string | null
  testPrincipalId: string | null
  createdIds: { articles: string[]; categories: string[] }
}

function createHCTestState(): HCTestState {
  return {
    testCategoryId: null,
    testArticleId: null,
    testPrincipalId: null,
    createdIds: { articles: [], categories: [] },
  }
}

const state = createHCTestState()
const baseState = createTestState()

/**
 * Fixture accessors. Setup either establishes all three or throws, so a null
 * here is a broken post-condition to report, never a reason to pass. They exist
 * so no case needs `if (!state.testArticleId) return`, which is how a failed
 * article creation used to be reported as six passing tests.
 */
function requireCategoryId(): string {
  if (!state.testCategoryId) throw new Error('Help Center category fixture is missing.')
  return state.testCategoryId
}

function requireArticleId(): string {
  if (!state.testArticleId) throw new Error('Help Center article fixture is missing.')
  return state.testArticleId
}

function requirePrincipalId(): string {
  if (!state.testPrincipalId) {
    throw new Error('Help Center author principal fixture is missing.')
  }
  return state.testPrincipalId
}

describe.skipIf(SKIP_INTEGRATION || !API_KEY)('Help Center Articles API', () => {
  beforeAll(async () => {
    // Throws on an unreachable server, a rejected key, or a fixture it could
    // not establish.
    await setUpIntegrationSuite(baseState)

    // Create a test category — requires admin role; fail loudly if key lacks it
    const { status: catStatus, data: catData } = await api('POST', '/help-center/categories', {
      name: `Test Category ${Date.now()}`,
      slug: `test-cat-${Date.now()}`,
    })
    if (catStatus !== 201) {
      throw new Error(
        `Help Center test setup failed: POST /help-center/categories returned ${catStatus}. ` +
          `API_KEY must have admin role to run these tests.`
      )
    }
    state.testCategoryId = (catData as { data: { id: string } }).data.id
    state.createdIds.categories.push(state.testCategoryId)

    // Get a team-member principal for the authorId cases. The article service
    // rejects any other author ("Author must be a team member"), and
    // GET /principals does NOT guarantee one: it lists every `type='user'`
    // principal, portal users included, so the first row is routinely a
    // role='user'. Filter by the role the route reports rather than trusting
    // position. No team member at all is a broken prerequisite, not a skip:
    // the cases below assert on author attribution and mean nothing without it.
    const { status: principalsStatus, data: principalsData } = await api('GET', '/principals')
    if (principalsStatus !== 200) {
      throw new Error(
        `Help Center test setup failed: GET /principals returned ${principalsStatus}.`
      )
    }
    const principals =
      (principalsData as { data?: Array<{ id: string; role?: string }> } | null)?.data ?? []
    const members = principals.filter((p) => p.role === 'admin' || p.role === 'member')
    if (!members[0]?.id) {
      throw new Error(
        'Help Center test setup failed: GET /principals returned no admin/member principal to ' +
          'attribute articles to.'
      )
    }
    state.testPrincipalId = members[0].id

    // Create the test article the PATCH cases operate on. An API key
    // authenticates as a service principal and the route rejects those without
    // an explicit authorId ("Service principals must provide an explicit
    // authorId"), so this call returned 400 on every run: testArticleId stayed
    // null and all six PATCH cases bare-returned as passing. A non-201 is now a
    // setup failure and reported as one. Seed it with a DIFFERENT principal
    // than the reassignment target when the target has more than one, so
    // "reassigns author when authorId is provided" observes an actual change
    // rather than a value that was already in place.
    const seedAuthorId = members[1]?.id ?? members[0].id
    const { status: artStatus, data: artData } = await api('POST', '/help-center/articles', {
      categoryId: requireCategoryId(),
      title: `Test Article ${Date.now()}`,
      content: 'Setup article for PATCH tests',
      authorId: seedAuthorId,
    })
    if (artStatus !== 201) {
      throw new Error(
        `Help Center test setup failed: POST /help-center/articles returned ${artStatus}.`
      )
    }
    state.testArticleId = (artData as { data: { id: string } }).data.id
    state.createdIds.articles.push(state.testArticleId)
  })

  afterAll(async () => {
    for (const id of state.createdIds.articles) {
      await api('DELETE', `/help-center/articles/${id}`)
    }
    for (const id of state.createdIds.categories) {
      await api('DELETE', `/help-center/categories/${id}`)
    }
    await cleanupCreatedResources(baseState.createdIds)
  })

  describe('POST /help-center/articles', () => {
    it.skipIf(!MEMBER_API_KEY)('is accessible by team members (not admin-only)', async () => {
      const { status, data } = await apiWith(
        'POST',
        '/help-center/articles',
        {
          categoryId: requireCategoryId(),
          title: `Team Member Article ${Date.now()}`,
          content: 'Created by team member',
        },
        MEMBER_API_KEY
      )
      expect(status).toBe(201)
      const id = (data as { data: { id: string } }).data.id
      state.createdIds.articles.push(id)
    })

    it('creates article attributed to authorId when provided', async () => {
      const { status, data } = await api('POST', '/help-center/articles', {
        categoryId: requireCategoryId(),
        title: `Authored Article ${Date.now()}`,
        content: 'Article with explicit author',
        authorId: requirePrincipalId(),
      })
      expect(status).toBe(201)
      const article = (data as { data: { id: string; author: { id: string } | null } }).data
      expect(article.author?.id).toBe(requirePrincipalId())
      state.createdIds.articles.push(article.id)
    })

    it('returns 400 for invalid authorId format', async () => {
      const { status } = await api('POST', '/help-center/articles', {
        categoryId: requireCategoryId(),
        title: 'Bad Author Article',
        content: 'Content',
        authorId: 'not_a_valid_typeid',
      })
      expect(status).toBe(400)
    })

    it('returns 400 for non-existent authorId', async () => {
      const { status } = await api('POST', '/help-center/articles', {
        categoryId: requireCategoryId(),
        title: 'Ghost Author Article',
        content: 'Content',
        // Valid TypeID format but doesn't exist in DB
        authorId: 'principal_01h455vb4pex5vsknk084sn02q',
      })
      expect(status).toBe(400)
    })
  })

  describe('PATCH /help-center/articles/:articleId', () => {
    it.skipIf(!MEMBER_API_KEY)('is accessible by team members (not admin-only)', async () => {
      const { status } = await apiWith(
        'PATCH',
        `/help-center/articles/${requireArticleId()}`,
        {
          title: 'Updated by Team Member',
        },
        MEMBER_API_KEY
      )
      expect(status).toBe(200)
    })

    it('reassigns author when authorId is provided', async () => {
      const { status, data } = await api('PATCH', `/help-center/articles/${requireArticleId()}`, {
        authorId: requirePrincipalId(),
      })
      expect(status).toBe(200)
      const article = (data as { data: { author: { id: string } | null } }).data
      expect(article.author?.id).toBe(requirePrincipalId())
    })

    it('returns 400 for invalid authorId format', async () => {
      const { status } = await api('PATCH', `/help-center/articles/${requireArticleId()}`, {
        authorId: 'not_a_valid_typeid',
      })
      expect(status).toBe(400)
    })

    it('returns 400 for non-existent authorId', async () => {
      const { status } = await api('PATCH', `/help-center/articles/${requireArticleId()}`, {
        authorId: 'principal_01h455vb4pex5vsknk084sn02q',
      })
      expect(status).toBe(400)
    })
  })
})
