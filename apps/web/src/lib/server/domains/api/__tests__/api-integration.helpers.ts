/**
 * Shared helpers for API integration tests.
 */

export const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000/api/v1'
export const API_KEY = process.env.API_KEY || ''
export const MEMBER_API_KEY = process.env.MEMBER_API_KEY || ''
export const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION === 'true'

// Helper to make API calls with a specific key (defaults to admin API_KEY)
export async function apiWith(
  method: string,
  path: string,
  body?: unknown,
  key?: string
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key ?? API_KEY}`,
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  let data: unknown = null
  if (res.status !== 204) {
    try {
      data = await res.json()
    } catch {
      data = null
    }
  }

  return { status: res.status, data }
}

// Helper to make API calls using the admin API_KEY
export async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  return apiWith(method, path, body, API_KEY)
}

export interface TestState {
  testBoardId: string | null
  testPostId: string | null
  createdIds: {
    posts: string[]
    boards: string[]
    tags: string[]
    roadmaps: string[]
    webhooks: string[]
  }
}

export function createTestState(): TestState {
  return {
    testBoardId: null,
    testPostId: null,
    createdIds: { posts: [], boards: [], tags: [], roadmaps: [], webhooks: [] },
  }
}

/** Read the `.data` payload of an envelope response, or null if it is absent. */
function envelope<T>(data: unknown): T | null {
  return ((data as { data?: T } | null)?.data ?? null) as T | null
}

/**
 * Fixture accessor for the board id {@link setUpIntegrationSuite} guarantees.
 *
 * A null here cannot mean "skip": setup either produced a board or threw, so
 * the only way to observe null is a suite whose beforeAll never ran or a future
 * edit that broke that post-condition. Both are failures to report. This exists
 * so no test needs `if (!state.testBoardId) return` — a bare return inside a
 * passing test is how sixteen unrun cases were reported green.
 */
export function requireBoardId(state: TestState): string {
  if (!state.testBoardId) {
    throw new Error(
      'Test board fixture is missing: setUpIntegrationSuite did not run or did not set it.'
    )
  }
  return state.testBoardId
}

/** Fixture accessor for the post id. See {@link requireBoardId}. */
export function requirePostId(state: TestState): string {
  if (!state.testPostId) {
    throw new Error(
      'Test post fixture is missing: setUpIntegrationSuite did not run or did not set it.'
    )
  }
  return state.testPostId
}

/** Create the board fixture the suites need when the target has none. */
async function createFixtureBoard(state: TestState): Promise<string> {
  const stamp = Date.now()
  const { status, data } = await api('POST', '/boards', {
    name: `Integration Fixture Board ${stamp}`,
    slug: `integration-fixture-${stamp}`,
  })
  if (status !== 201) {
    throw new Error(
      `Integration setup failed: the target has no board and POST /boards returned ${status}. ` +
        `API_KEY must have admin role to run these tests.`
    )
  }
  const id = envelope<{ id: string }>(data)?.id
  if (!id) {
    throw new Error('Integration setup failed: POST /boards returned 201 with no board id.')
  }
  state.createdIds.boards.push(id)
  return id
}

/** Create the post fixture the suites need when the target has none. */
async function createFixturePost(state: TestState, boardId: string): Promise<string> {
  const { status, data } = await api('POST', '/posts', {
    boardId,
    title: `Integration Fixture Post ${Date.now()}`,
    content: 'Fixture post created by the API integration suite setup.',
  })
  if (status !== 201) {
    throw new Error(
      `Integration setup failed: the target has no post and POST /posts returned ${status}.`
    )
  }
  const id = envelope<{ id: string }>(data)?.id
  if (!id) {
    throw new Error('Integration setup failed: POST /posts returned 201 with no post id.')
  }
  state.createdIds.posts.push(id)
  return id
}

/**
 * Reach the live server and establish every fixture the suites depend on.
 *
 * Throws on every failure instead of returning a boolean. The boolean was the
 * bug: `checkServerAndSetup` returned `true` whenever the server answered, even
 * when it left `testBoardId` / `testPostId` null, and the per-test
 * `if (skipIfNoServer() || !state.testBoardId) return` guards then reported
 * those unrun cases as passed. A beforeAll that throws is loud and attributable;
 * "the fixture is missing" is never a reason to pass.
 *
 * The honest skip — integration tests were not requested — is expressed by the
 * suites' own `describe.skipIf(SKIP_INTEGRATION || !API_KEY)`, which reports
 * them as skipped and never reaches this function.
 */
export async function setUpIntegrationSuite(state: TestState): Promise<void> {
  if (!API_KEY) {
    throw new Error(
      'API_KEY is required to run the API integration suites. ' +
        'Run with: API_KEY=qb_xxx bun run test api-integration'
    )
  }

  let res: Response
  try {
    res = await fetch(`${BASE_URL}/boards`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
  } catch (error) {
    throw new Error(`Server not running at ${BASE_URL} - start it with: bun run dev`, {
      cause: error,
    })
  }

  if (res.status === 401) {
    throw new Error('Invalid API key - API integration tests cannot run')
  }
  if (res.status !== 200) {
    throw new Error(
      `Server not responding correctly - GET ${BASE_URL}/boards returned ${res.status}`
    )
  }

  // Prefer the target's own data; create the fixture when it has none, so an
  // empty database is a slower setup rather than a silently skipped suite.
  const boards = envelope<Array<{ id: string }>>(await res.json()) ?? []
  state.testBoardId = boards[0]?.id ?? (await createFixtureBoard(state))

  const { data: postsData } = await api('GET', '/posts')
  const posts = envelope<Array<{ id: string }>>(postsData) ?? []
  state.testPostId = posts[0]?.id ?? (await createFixturePost(state, state.testBoardId))
}

// Cleanup all created resources
export async function cleanupCreatedResources(createdIds: TestState['createdIds']): Promise<void> {
  for (const id of createdIds.posts) {
    await api('DELETE', `/posts/${id}`)
  }
  for (const id of createdIds.webhooks) {
    await api('DELETE', `/webhooks/${id}`)
  }
  for (const id of createdIds.tags) {
    await api('DELETE', `/tags/${id}`)
  }
  for (const id of createdIds.roadmaps) {
    await api('DELETE', `/roadmaps/${id}`)
  }
  for (const id of createdIds.boards) {
    await api('DELETE', `/boards/${id}`)
  }
}
