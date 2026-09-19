import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId, toUuid } from '@quackback/ids'
import { encodePublicPostCursor, decodePublicPostCursor } from '../post.public-cursor'

const { queries, rows } = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  rows: vi.fn(),
}))
vi.mock('@/lib/server/db', async () => {
  const schema = await import('@quackback/db/schema')
  const operators = await import('drizzle-orm')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const queryDb = drizzle.mock({ schema })
  return {
    ...schema,
    ...operators,
    db: {
      select: (fields: Parameters<typeof queryDb.select>[0]) => {
        const selection = queryDb.select(fields)
        const from = selection.from.bind(selection)
        selection.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args)
          const offset = query.offset.bind(query)
          // Compile the real Drizzle query at its execution boundary, then
          // supply fixture rows without opening a database connection.
          query.offset = ((value: number) => {
            queries.push(offset(value).toSQL())
            return rows()
          }) as typeof query.offset
          return query
        }) as typeof selection.from
        return selection
      },
      selectDistinct: queryDb.selectDistinct.bind(queryDb),
      query: {
        posts: {
          findFirst: () => {
            throw new Error('Cursor-row lookup is forbidden')
          },
        },
      },
    },
  }
})
vi.mock('@/lib/server/storage/s3', () => ({ getPublicUrlOrNull: vi.fn() }))
import { listPublicPosts, listPublicPostsWithVotesAndAvatars } from '../post.public'

function fixture(timestamp = '2026-09-19T12:34:56.123456Z') {
  return {
    id: generateId('post'),
    title: 'Post',
    content: 'Content',
    statusId: null,
    voteCount: 0,
    commentCount: 0,
    principalId: generateId('principal'),
    createdAt: new Date(timestamp),
    cursorCreatedAt: timestamp,
    boardId: generateId('board'),
    boardName: 'Ideas',
    boardSlug: 'ideas',
    tagsJson: [],
    authorName: null,
    avatarData: null,
    hasVoted: false,
  }
}
beforeEach(() => {
  queries.length = 0
  rows.mockReset().mockResolvedValue([])
})

describe.each([
  ['plain', listPublicPosts],
  ['with avatars', listPublicPostsWithVotesAndAvatars],
] as const)('%s public pagination', (_name, list) => {
  it('starts a bounded newest query with exact UTC timestamps, ID ties, and no OFFSET', async () => {
    const batch = [fixture(), fixture(), fixture()]
    rows.mockResolvedValue(batch)
    const result = await list({ sort: 'new', cursor: null, limit: 2 })
    const { sql, params } = queries[0]
    expect(sql).toContain("AT TIME ZONE 'UTC'")
    expect(sql).toContain('SS.US')
    expect(sql).toMatch(/order by "posts"\."created_at" desc, "posts"\."id" desc limit/)
    expect(sql).not.toMatch(/ offset /)
    expect(params.at(-1)).toBe(3)
    expect(result.items.map(({ id }) => id)).toEqual(batch.slice(0, 2).map(({ id }) => id))
    expect(result.items[0]).not.toHaveProperty('cursorCreatedAt')
    expect(decodePublicPostCursor(result.nextCursor!, { limit: 2 })).toEqual({
      id: batch[1].id,
      createdAt: batch[1].cursorCreatedAt,
    })
  })

  it('seeks with exact microseconds even when the cursor row has been deleted', async () => {
    const cursorPost = fixture('2026-09-19T12:34:56.123456Z')
    const cursor = encodePublicPostCursor(cursorPost, { boardSlug: 'ideas', limit: 2 })
    rows.mockResolvedValue([fixture('2026-09-19T12:34:56.123123Z')])
    const result = await list({ sort: 'new', boardSlug: 'ideas', cursor, limit: 2 })
    const { sql, params } = queries[0]
    expect(sql).toContain('("posts"."created_at", "posts"."id") <')
    expect(params).toContain('2026-09-19T12:34:56.123456Z')
    expect(params).toContain(toUuid(cursorPost.id))
    expect(params).not.toContain('2026-09-19T12:34:56.123Z')
    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
  })

  it('keeps authorization/visibility and other filters before the seek and limit', async () => {
    const filters = { boardSlug: 'ideas', minVotes: 4, responded: 'unresponded' as const, limit: 2 }
    const cursor = encodePublicPostCursor(fixture(), filters)
    await list({ ...filters, sort: 'new', cursor })
    const { sql } = queries[0]
    expect(sql).toContain('"boards"."deleted_at" is null')
    expect(sql).toContain('"posts"."deleted_at" is null')
    expect(sql).toContain('"posts"."canonical_post_id" is null')
    expect(sql).toContain('"posts"."moderation_state"')
    expect(sql).toContain('"boards"."access"')
    expect(sql).toContain('"posts"."vote_count" >=')
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM comments')
    expect(sql.indexOf(' where ')).toBeLessThan(sql.lastIndexOf(' limit '))
  })

  it.each(['new', 'top', 'trending'] as const)(
    'preserves legacy %s page-number queries',
    async (sort) => {
      const result = await list({ sort, page: 3, limit: 20 })
      const { sql, params } = queries[0]
      expect(sql).toMatch(/ offset /)
      expect(params.at(-1)).toBe(40)
      expect(sql).not.toContain('cursor_created_at')
      expect(result).not.toHaveProperty('nextCursor')
      if (sort === 'trending') expect(sql).toContain('NOW()')
    }
  )

  it.each([
    { sort: 'top' as const, cursor: null },
    { sort: 'trending' as const, cursor: null },
    { sort: 'new' as const, cursor: null, page: 2 },
    { sort: 'new' as const, cursor: null, limit: 101 },
    { sort: 'new' as const, cursor: null, limit: 0 },
    { sort: 'new' as const, cursor: 'malformed' },
  ])('rejects incompatible cursor requests before execution: %j', async (params) => {
    await expect(list(params)).rejects.toThrow()
    expect(queries).toHaveLength(0)
  })

  it('ends empty or final cursor pages explicitly', async () => {
    expect((await list({ sort: 'new', cursor: null })).nextCursor).toBeNull()
  })
})
