import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId, toUuid } from '@quackback/ids'

const { queries, rows, cursorPost } = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  rows: vi.fn(),
  cursorPost: vi.fn(),
}))

vi.mock('@/lib/server/db', async () => {
  const schema = await import('@quackback/db/schema')
  const operators = await import('drizzle-orm')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  // Compile the production relational query with the real schema and alias
  // rewriting, but never connect to Postgres or execute a database query.
  const queryDb = drizzle.mock({ schema })
  return {
    ...schema,
    ...operators,
    db: {
      select: queryDb.select.bind(queryDb),
      selectDistinct: queryDb.selectDistinct.bind(queryDb),
      query: {
        posts: {
          findFirst: cursorPost,
          findMany: async (options: Parameters<typeof queryDb.query.posts.findMany>[0]) => {
            queries.push(queryDb.query.posts.findMany(options).toSQL())
            return rows()
          },
        },
      },
    },
  }
})

import { listInboxPosts } from '../post.inbox'

beforeEach(() => {
  queries.length = 0
  rows.mockReset().mockResolvedValue([])
  cursorPost.mockReset().mockResolvedValue(null)
})

describe('inbox duplicate filter', () => {
  it('requires a pending source or target match before the page limit', async () => {
    await listInboxPosts({ hasDuplicates: true, limit: 2 })

    expect(queries).toHaveLength(1)
    const { sql, params } = queries[0]
    expect(sql).toContain("merge_suggestions.status = 'pending'")
    expect(sql).toContain('merge_suggestions.source_post_id = "posts"."id"')
    expect(sql).toContain('OR merge_suggestions.target_post_id = "posts"."id"')
    expect(sql.indexOf('EXISTS (SELECT 1 FROM merge_suggestions')).toBeLessThan(
      sql.lastIndexOf(' limit ')
    )
    expect(params.at(-1)).toBe(3)
    expect(sql).toContain('"posts"."canonical_post_id" is null')
    expect(sql).toContain('"posts"."deleted_at" is null')
    expect(sql).toContain('"posts"."moderation_state" <>')
  })

  it.each([undefined, false])('keeps the normal query for hasDuplicates=%s', async (value) => {
    await listInboxPosts({ hasDuplicates: value })
    expect(queries[0].sql).not.toContain('merge_suggestions')
  })

  it('combines duplicates with existing filters and the keyset cursor', async () => {
    const boardId = generateId('board')
    const postId = generateId('post')
    cursorPost.mockResolvedValue({
      id: postId,
      createdAt: new Date('2026-09-19T12:00:00Z'),
      voteCount: 10,
    })

    await listInboxPosts({
      hasDuplicates: true,
      boardIds: [boardId],
      minVotes: 5,
      responded: 'unresponded',
      sort: 'votes',
      cursor: postId,
      limit: 2,
    })

    const { sql, params } = queries[0]
    expect(sql).toContain('EXISTS (SELECT 1 FROM merge_suggestions')
    expect(sql).toContain('"posts"."board_id" in')
    expect(params).toContain(toUuid(boardId))
    expect(sql).toContain('"posts"."vote_count" >=')
    expect(params).toContain(5)
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM comments')
    expect(sql).toContain('("posts"."vote_count", "posts"."created_at", "posts"."id") <')
    expect(params).toContain(toUuid(postId))
  })

  it('preserves deleted-view rules and derives pagination from matching rows', async () => {
    const matches = Array.from({ length: 3 }, () => ({
      id: generateId('post'),
      tags: [],
      board: null,
      author: null,
      commentCount: 0,
    }))
    rows.mockResolvedValue(matches)

    const result = await listInboxPosts({ hasDuplicates: true, showDeleted: true, limit: 2 })

    expect(result.items.map((item) => item.id)).toEqual(matches.slice(0, 2).map((item) => item.id))
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).toBe(matches[1].id)
    expect(queries[0].sql).toContain('"posts"."deleted_at" is not null')
    expect(queries[0].sql).not.toContain('"posts"."moderation_state" <>')
    expect(queries[0].sql).toContain('EXISTS (SELECT 1 FROM merge_suggestions')
  })
})
