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
  serverAvailable: boolean
  testBoardId: string | null
  testPostId: string | null
  createdIds: { posts: string[]; boards: string[]; tags: string[]; roadmaps: string[] }
}

export function createTestState(): TestState {
  return {
    serverAvailable: false,
    testBoardId: null,
    testPostId: null,
    createdIds: { posts: [], boards: [], tags: [], roadmaps: [] },
  }
}

// Check if server is running and populate test state.
//
// No API_KEY is the honest "integration tests were not requested" path: it
// returns false, and the suites' `describe.skipIf(SKIP_INTEGRATION || !API_KEY)`
// already reports them as skipped. Every other outcome means the caller DID ask
// for integration tests and they cannot run, so throw: a beforeAll failure is
// loud, where returning false would let the per-test guards report green
// against a dead server.
export async function checkServerAndSetup(state: TestState): Promise<boolean> {
  if (!API_KEY) {
    console.warn('⚠️ No API_KEY provided - skipping API integration tests')
    console.warn('   Run with: API_KEY=qb_xxx bun run test api-integration')
    return false
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

  // Get test data
  const boardsData = await res.json()
  const boards = (boardsData as { data: Array<{ id: string }> })?.data || []
  if (boards.length > 0) {
    state.testBoardId = boards[0].id
  }

  const { data: postsData } = await api('GET', '/posts')
  const posts = (postsData as { data: Array<{ id: string }> })?.data || []
  if (posts.length > 0) {
    state.testPostId = posts[0].id
  }

  return true
}

// Cleanup all created resources
export async function cleanupCreatedResources(createdIds: TestState['createdIds']): Promise<void> {
  for (const id of createdIds.posts) {
    await api('DELETE', `/posts/${id}`)
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
