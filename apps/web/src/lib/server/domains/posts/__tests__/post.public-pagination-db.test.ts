import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateId, toUuid } from '@quackback/ids'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { decodePublicPostCursor } from '../post.public-cursor'

// This suite belongs to the existing PostgreSQL test gate. It executes the
// production queries against rollback-only fixtures, not a model of their SQL.
const state = vi.hoisted(() => ({ transaction: undefined as object | undefined }))
vi.mock('@/lib/server/db', async () => {
  const schema = await import('@quackback/db/schema')
  const operators = await import('drizzle-orm')
  const { DEFAULT_BOARD_ACCESS } = await import('@quackback/db/types')
  return {
    ...schema,
    ...operators,
    DEFAULT_BOARD_ACCESS,
    db: new Proxy(
      {},
      {
        get(_target, key) {
          if (!state.transaction) throw new Error('Queries must stay inside the test transaction')
          const value = Reflect.get(state.transaction, key)
          return typeof value === 'function' ? value.bind(state.transaction) : value
        },
      }
    ),
  }
})
vi.mock('@/lib/server/storage/s3', () => ({ getPublicUrlOrNull: vi.fn() }))
import { boards, principal, posts, sql, eq, DEFAULT_BOARD_ACCESS } from '@/lib/server/db'
import { listPublicPosts, listPublicPostsWithVotesAndAvatars } from '../post.public'

let client: ReturnType<typeof postgres>
beforeAll(() => {
  const connection = process.env.DATABASE_URL
  if (!connection) throw new Error('The PostgreSQL test gate must supply DATABASE_URL')
  const url = new URL(connection)
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/quackback_test'
  ) {
    throw new Error('Cursor fixtures require the local quackback_test database')
  }
  client = postgres(connection, { max: 1, connect_timeout: 3 })
})
afterAll(async () => {
  if (client) await client.end({ timeout: 1 })
})

describe.each([
  ['plain', listPublicPosts],
  ['with avatars', listPublicPostsWithVotesAndAvatars],
] as const)('%s newest cursor on PostgreSQL', (_name, list) => {
  it('traverses microsecond/ID ties after a cursor-row deletion, new insert, and vote change', async () => {
    const schema = await import('@quackback/db/schema')
    const database = drizzle(client, { schema })
    const rollback = new Error('rollback cursor fixtures')
    try {
      await database.transaction(async (tx) => {
        state.transaction = tx
        try {
          const boardId = generateId('board')
          const authorId = generateId('principal')
          const slug = `cursor-${boardId}`
          const publicAccess = { ...DEFAULT_BOARD_ACCESS, view: 'anonymous' as const }
          await tx
            .insert(boards)
            .values({ id: boardId, slug, name: 'Cursor fixtures', access: publicAccess })
          await tx
            .insert(principal)
            .values({ id: authorId, type: 'service', role: 'user', createdAt: new Date() })
          const visible = ['123900', '123800', '123800', '123700', '123100', '122999']
            .map((fraction) => ({
              id: generateId('post'),
              exact: `2026-09-19T12:34:56.${fraction}Z`,
            }))
            .sort(
              (a, b) => b.exact.localeCompare(a.exact) || toUuid(b.id).localeCompare(toUuid(a.id))
            )
          const insert = (id: (typeof visible)[number]['id'], exact: string, extra = {}) =>
            tx.insert(posts).values({
              id,
              boardId,
              principalId: authorId,
              title: 'Cursor fixture',
              content: 'Local test only',
              createdAt: sql`${exact}::timestamptz`,
              ...extra,
            })
          for (const post of visible) await insert(post.id, post.exact)
          await insert(generateId('post'), '2026-09-19T12:34:57.000000Z', {
            moderationState: 'pending',
          })
          await insert(generateId('post'), '2026-09-19T12:34:58.000000Z', { deletedAt: new Date() })
          await insert(generateId('post'), '2026-09-19T12:34:59.000000Z', {
            canonicalPostId: visible[0].id,
          })

          const params = { sort: 'new' as const, boardSlug: slug, limit: 2 }
          const first = await list({ ...params, cursor: null })
          expect(first.items.map(({ id }) => id)).toEqual(visible.slice(0, 2).map(({ id }) => id))
          const boundary = decodePublicPostCursor(first.nextCursor!, params)
          expect(boundary.createdAt).toBe('2026-09-19T12:34:56.123800Z')

          await tx.delete(posts).where(eq(posts.id, boundary.id))
          const newId = generateId('post')
          await insert(newId, '2026-09-19T12:34:56.999999Z')
          await tx
            .update(posts)
            .set({ voteCount: 999 })
            .where(eq(posts.id, visible.at(-1)!.id))

          // Re-evaluate visibility on every page, even with a previously issued cursor.
          await tx
            .update(boards)
            .set({ access: { ...publicAccess, view: 'team' } })
            .where(eq(boards.id, boardId))
          expect((await list({ ...params, cursor: first.nextCursor! })).items).toEqual([])
          await tx.update(boards).set({ access: publicAccess }).where(eq(boards.id, boardId))

          const seen = first.items.map(({ id }) => id)
          let cursor = first.nextCursor
          let pageCount = 1
          while (cursor) {
            const page = await list({ ...params, cursor })
            seen.push(...page.items.map(({ id }) => id))
            cursor = page.nextCursor
            expect(++pageCount).toBeLessThanOrEqual(3)
          }
          expect(seen).toEqual(visible.map(({ id }) => id))
          expect(new Set(seen).size).toBe(seen.length)
          expect(seen).not.toContain(newId)
          throw rollback
        } finally {
          state.transaction = undefined
        }
      })
    } catch (error) {
      if (error !== rollback) throw error
    }
  })
})

describe.each([
  ['plain', listPublicPosts],
  ['with avatars', listPublicPostsWithVotesAndAvatars],
] as const)('%s ranked pages on PostgreSQL', (_name, list) => {
  it.each(['top', 'trending'] as const)(
    'keeps %s membership, filters, ties, hasMore and page boundaries',
    async (sort) => {
      const schema = await import('@quackback/db/schema')
      const database = drizzle(client, { schema })
      const rollback = new Error('rollback ranked fixtures')
      try {
        await database.transaction(async (tx) => {
          state.transaction = tx
          try {
            const boardId = generateId('board')
            const authorId = generateId('principal')
            const slug = 'ranked-' + boardId
            const publicAccess = { ...DEFAULT_BOARD_ACCESS, view: 'anonymous' as const }
            await tx.insert(boards).values({
              id: boardId,
              slug,
              name: 'Ranked fixtures',
              access: publicAccess,
            })
            await tx.insert(principal).values({
              id: authorId,
              type: 'service',
              role: 'user',
              createdAt: new Date(),
            })
            const visible = Array.from({ length: 31 }, (_, i) => ({
              id: generateId('post'),
              voteCount: 40 - Math.floor(i / 4),
            })).sort(
              (a, b) => b.voteCount - a.voteCount || toUuid(b.id).localeCompare(toUuid(a.id))
            )
            const insert = (id: (typeof visible)[number]['id'], voteCount: number, extra = {}) =>
              tx.insert(posts).values({
                id,
                boardId,
                principalId: authorId,
                voteCount,
                title: 'Ranked fixture',
                content: 'Exact ranked content',
                // Equal age makes top and trending tie semantics independently comparable.
                createdAt: sql.raw("NOW() - INTERVAL '10 days'"),
                ...extra,
              })
            for (const row of visible) await insert(row.id, row.voteCount)
            await insert(generateId('post'), 999, { moderationState: 'pending' })
            await insert(generateId('post'), 999, { deletedAt: new Date() })
            await insert(generateId('post'), 999, { canonicalPostId: visible[0].id })
            const params = { sort, boardSlug: slug, limit: 5, minVotes: 35 }
            const eligible = visible.filter((row) => row.voteCount >= 35)
            const seen = []
            for (let page = 1; page <= 5; page++) {
              const result = await list({ ...params, page })
              const expected = eligible.slice((page - 1) * 5, page * 5)
              expect(result.items.map(({ id }) => id)).toEqual(expected.map(({ id }) => id))
              expect(result.items.every((row) => row.content === 'Exact ranked content')).toBe(true)
              expect(result.hasMore).toBe(eligible.length > page * 5)
              expect(result).not.toHaveProperty('nextCursor')
              seen.push(...result.items.map(({ id }) => id))
            }
            expect(seen).toEqual(eligible.map(({ id }) => id))
            expect(new Set(seen).size).toBe(seen.length)
            // The page window must not evade the current access check.
            await tx
              .update(boards)
              .set({ access: { ...publicAccess, view: 'team' } })
              .where(eq(boards.id, boardId))
            expect((await list({ ...params, page: 2 })).items).toEqual([])
            throw rollback
          } finally {
            state.transaction = undefined
          }
        })
      } catch (error) {
        if (error !== rollback) throw error
      }
    }
  )
})
