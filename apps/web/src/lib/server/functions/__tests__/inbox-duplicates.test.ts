import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'

type Input = { data: Record<string, unknown> }

vi.mock('@tanstack/react-start', () => ({
  // workspace.ts getSettings is server-only (createServerOnlyFn).
  createServerOnlyFn: <T>(fn: T) => fn,
  createServerFn: () => {
    let schema: { parse(value: unknown): Input['data'] } | undefined
    const chain = {
      validator(value: typeof schema) {
        schema = value
        return chain
      },
      handler(fn: (args: Input) => Promise<unknown>) {
        return async ({ data }: Input) => fn({ data: schema ? schema.parse(data) : data })
      },
    }
    return chain
  },
}))

const { listInboxPosts, requireAuth } = vi.hoisted(() => ({
  listInboxPosts: vi.fn(),
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/server/domains/posts/post.inbox', () => ({ listInboxPosts }))
vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth,
  policyActorFromAuth: vi.fn(),
}))
vi.mock('@/lib/server/domains/notifications/notification.service', () => ({}))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Inbox handler unit tests must not connect to a database')
  },
}))

import { fetchInboxPosts } from '../admin'
import { fetchInboxPostsForAdmin } from '../posts'

// The inbox schemas take only ids the id columns accept: TypeIDs of the entity.
const BOARD_ID = generateId('board')
const CURSOR_POST_ID = generateId('post')

beforeEach(() => {
  vi.clearAllMocks()
  requireAuth.mockResolvedValue({})
  listInboxPosts.mockResolvedValue({ items: [], nextCursor: null, hasMore: false })
})

describe.each([
  ['route loader', fetchInboxPosts],
  ['infinite query', fetchInboxPostsForAdmin],
] as const)('%s duplicate filter', (_name, fetchPosts) => {
  it.each([true, false, undefined])('validates and forwards hasDuplicates=%s', async (value) => {
    await fetchPosts({
      data: {
        hasDuplicates: value,
        boardIds: [BOARD_ID],
        statusSlugs: ['open'],
        minVotes: 5,
        sort: 'votes',
        cursor: CURSOR_POST_ID,
        limit: 2,
      },
    })

    expect(requireAuth).toHaveBeenCalledWith({ roles: ['admin', 'member'] })
    expect(listInboxPosts).toHaveBeenCalledWith(
      expect.objectContaining({
        hasDuplicates: value,
        boardIds: [BOARD_ID],
        statusSlugs: ['open'],
        minVotes: 5,
        sort: 'votes',
        cursor: CURSOR_POST_ID,
        limit: 2,
      }),
      { preview: true }
    )
  })

  it('rejects a non-boolean duplicate filter', async () => {
    await expect(
      fetchPosts({
        // Exercise runtime validation of untrusted input.
        // @ts-expect-error The public type correctly requires a boolean.
        data: { hasDuplicates: 'true' },
      })
    ).rejects.toThrow()
    expect(listInboxPosts).not.toHaveBeenCalled()
  })

  it('serializes a preview without adding full document fields', async () => {
    listInboxPosts.mockResolvedValue({
      items: [
        {
          id: 'post_preview',
          excerpt: 'Already normalized <literal> text',
          createdAt: new Date('2026-09-19T12:00:00Z'),
          updatedAt: new Date('2026-09-19T12:00:00Z'),
          deletedAt: null,
        },
      ],
      nextCursor: null,
      hasMore: false,
    })
    const result = await fetchPosts({ data: {} })
    expect(result.items[0]).toEqual({
      id: 'post_preview',
      excerpt: 'Already normalized <literal> text',
      createdAt: '2026-09-19T12:00:00.000Z',
      updatedAt: '2026-09-19T12:00:00.000Z',
      deletedAt: null,
    })
  })

  it('checks team authorization before querying duplicates', async () => {
    requireAuth.mockRejectedValue(new Error('Unauthorized'))
    await expect(fetchPosts({ data: { hasDuplicates: true } })).rejects.toThrow('Unauthorized')
    expect(listInboxPosts).not.toHaveBeenCalled()
  })
})
