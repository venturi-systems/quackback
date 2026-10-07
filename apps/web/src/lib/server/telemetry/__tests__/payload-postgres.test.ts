import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { boards, posts, user, type Database } from '@/lib/server/db'
import { buildPayload } from '../payload'

// Keep the application's real schema and SQL execution. Only redirect its lazy
// database handle to this test's transaction; PostgreSQL still executes the query.
const state = vi.hoisted(() => ({ db: null as Pick<Database, 'execute'> | null }))
vi.mock('@/lib/server/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/db')>()
  return {
    ...actual,
    get db() {
      if (!state.db) throw new Error('Telemetry fixture transaction is not active')
      return state.db
    },
  }
})
vi.mock('../instance-id', () => ({ getOrCreateInstanceId: async () => 'fixture-only' }))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getDeveloperConfig: async () => ({ mcpEnabled: false }),
  getFeatureFlags: async () => ({}),
}))
vi.mock('@/lib/server/domains/settings/settings.widget', () => ({
  getWidgetConfig: async () => ({ enabled: false }),
}))

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('Telemetry SQL tests require DATABASE_URL')
const url = new URL(databaseUrl)
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
) {
  throw new Error('Telemetry SQL fixtures require an isolated loopback test database')
}
const client = postgres(databaseUrl, { max: 1 })
const testDb = drizzle(client)
const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('__APP_VERSION__', 'test')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset().mockRejectedValue(new Error('No network reporting is permitted in tests'))
})
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  state.db = null
})
afterAll(async () => {
  await client.end()
})

describe('usage scale against the real PostgreSQL schema', () => {
  it.each([
    { users: 0, posts: 0, boards: 0, expected: { users: '0', posts: '0', boards: '0' } },
    {
      users: 2,
      posts: 11,
      boards: 51,
      expected: { users: '1-10', posts: '11-50', boards: '51-200' },
    },
    {
      users: 201,
      posts: 10,
      boards: 50,
      expected: { users: '200+', posts: '1-10', boards: '11-50' },
    },
    { users: 0, posts: 200, boards: 1, expected: { users: '0', posts: '51-200', boards: '1-10' } },
  ])(
    'reports correct brackets for $users users, $posts posts and $boards boards',
    async (counts) => {
      await testDb.transaction(async (tx) => {
        // Connection-local tables copy the migrated schema. They shadow public
        // tables only for this transaction and disappear on either commit or rollback.
        await tx.execute(
          sql`CREATE TEMP TABLE "user" (LIKE public."user" INCLUDING DEFAULTS INCLUDING GENERATED) ON COMMIT DROP`
        )
        await tx.execute(
          sql`CREATE TEMP TABLE "posts" (LIKE public."posts" INCLUDING DEFAULTS INCLUDING GENERATED) ON COMMIT DROP`
        )
        await tx.execute(
          sql`CREATE TEMP TABLE "boards" (LIKE public."boards" INCLUDING DEFAULTS INCLUDING GENERATED) ON COMMIT DROP`
        )
        await tx.execute(sql`INSERT INTO ${user} (id, name)
        SELECT gen_random_uuid(), 'Test person' FROM generate_series(1, ${counts.users})`)
        await tx.execute(sql`INSERT INTO ${boards} (id, slug, name)
        SELECT gen_random_uuid(), 'test-board-' || n, 'Test board' FROM generate_series(1, ${counts.boards}) AS n`)
        await tx.execute(sql`INSERT INTO ${posts} (id, board_id, principal_id, title, content)
        SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'Test request', 'Test content'
        FROM generate_series(1, ${counts.posts})`)
        state.db = tx
        expect((await buildPayload()).scale).toEqual(counts.expected)
      })
    }
  )
})
