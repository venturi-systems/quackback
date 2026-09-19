import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
import { inboxContentPreview, INBOX_PREVIEW_MAX_LENGTH } from '@/lib/shared/utils/inbox-preview'

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
      select: queryDb.select.bind(queryDb),
      selectDistinct: queryDb.selectDistinct.bind(queryDb),
      query: {
        posts: {
          findFirst: vi.fn().mockResolvedValue(null),
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

function fixture() {
  const content = '<p>**Long post** [link](https://example.com)</p> ' + '🦆 feedback '.repeat(800)
  return {
    id: generateId('post'),
    boardId: generateId('board'),
    title: 'Long feedback',
    content,
    contentJson: { type: 'doc', content: [{ type: 'text', text: content }] },
    summaryJson: { summary: 'Summary '.repeat(500) },
    summaryUpdatedAt: new Date(),
    principalId: generateId('principal'),
    statusId: null,
    ownerPrincipalId: null,
    voteCount: 3,
    commentCount: 2,
    pinnedCommentId: null,
    createdAt: new Date('2026-09-19T12:00:00Z'),
    updatedAt: new Date('2026-09-19T12:00:00Z'),
    deletedAt: null,
    isCommentsLocked: false,
    moderationState: 'published',
    canonicalPostId: null,
    mergedAt: null,
    board: { id: generateId('board'), name: 'Ideas', slug: 'ideas' },
    tags: [{ tag: { id: generateId('tag'), name: 'Improvement', color: '#123456' } }],
    author: { displayName: 'Test author' },
  }
}
beforeEach(() => {
  queries.length = 0
  rows.mockReset()
})

describe('admin inbox preview projection', () => {
  it('does not select rich documents and returns only the explicit bounded DTO', async () => {
    const post = fixture()
    rows.mockResolvedValue([post])
    const result = await listInboxPosts({ hasDuplicates: true }, { preview: true })
    expect(result.items[0]).toEqual({
      id: post.id,
      boardId: post.boardId,
      title: post.title,
      excerpt: inboxContentPreview(post.content),
      statusId: post.statusId,
      ownerPrincipalId: post.ownerPrincipalId,
      voteCount: post.voteCount,
      commentCount: post.commentCount,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
      board: post.board,
      tags: post.tags.map(({ tag }) => tag),
      authorName: post.author.displayName,
    })
    for (const column of ['content_json', 'summary_json', 'summary_updated_at']) {
      expect(queries[0].sql).not.toContain(`"posts"."${column}"`)
    }
    expect(queries[0].sql).toContain('"posts"."content"')
    expect(queries[0].sql).toContain("merge_suggestions.status = 'pending'")
    expect(result.items[0].excerpt.length).toBeLessThanOrEqual(INBOX_PREVIEW_MAX_LENGTH + 3)
  })

  it('preserves the full-content default used by REST and MCP', async () => {
    const post = fixture()
    rows.mockResolvedValue([post])
    const result = await listInboxPosts({})
    expect(result.items[0].content).toBe(post.content)
    expect(result.items[0].contentJson).toEqual(post.contentJson)
    expect(result.items[0].summaryJson).toEqual(post.summaryJson)
    expect(result.items[0].isCommentsLocked).toBe(post.isCommentsLocked)
    expect(queries[0].sql).toContain('"posts"."content_json"')
    expect(queries[0].sql).toContain('"posts"."summary_json"')
  })

  it.each([false, true])(
    'preserves query predicates and page cursors with deleted=%s',
    async (showDeleted) => {
      const posts = Array.from({ length: 3 }, fixture)
      rows.mockResolvedValue(posts)
      const params = { hasDuplicates: true, showDeleted, boardIds: [posts[0].boardId], limit: 2 }
      const full = await listInboxPosts(params)
      const preview = await listInboxPosts(params, { preview: true })
      expect(preview.items.map(({ id }) => id)).toEqual(full.items.map(({ id }) => id))
      expect(preview.nextCursor).toBe(full.nextCursor)
      expect(preview.hasMore).toBe(full.hasMore)
      const predicates = queries.map(({ sql }) => sql.slice(sql.lastIndexOf(' where ')))
      expect(predicates[1]).toBe(predicates[0])
      expect(predicates[1]).toContain('"posts"."canonical_post_id" is null')
      expect(predicates[1]).toContain('merge_suggestions.target_post_id')
      expect(predicates[1]).toContain(
        showDeleted ? '"posts"."deleted_at" is not null' : '"posts"."moderation_state" <>'
      )
    }
  )

  it.each([20, 200, 1_000])(
    'bounds serialized list payloads for %s long-document posts',
    async (count) => {
      // Deterministic response-size evidence, not a production heap/latency claim.
      const posts = Array.from({ length: count }, fixture)
      const fullPages = []
      const previewPages = []
      for (let offset = 0; offset < count; offset += 20) {
        rows.mockResolvedValue(posts.slice(offset, offset + 20))
        fullPages.push(await listInboxPosts({ limit: 20 }))
        previewPages.push(await listInboxPosts({ limit: 20 }, { preview: true }))
      }
      const fullBytes = Buffer.byteLength(JSON.stringify({ pages: fullPages }))
      const previewBytes = Buffer.byteLength(JSON.stringify({ pages: previewPages }))
      const previewItems = previewPages.flatMap((page) => page.items)
      expect(previewItems).toHaveLength(count)
      expect(previewBytes).toBeLessThan(fullBytes / 10)
      expect(previewBytes).toBeLessThan(count * 1_200)
      for (const post of previewItems) {
        expect(post).not.toHaveProperty('content')
        expect(post).not.toHaveProperty('contentJson')
        expect(post).not.toHaveProperty('summaryJson')
      }
      console.info(
        'INBOX_PREVIEW_FIXTURE_BYTES',
        JSON.stringify({ posts: count, fullBytes, previewBytes })
      )
    }
  )
})
