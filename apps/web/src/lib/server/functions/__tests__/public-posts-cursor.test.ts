import { beforeEach, describe, expect, it, vi } from 'vitest'

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
      handler(fn: (input: Input) => Promise<unknown>) {
        return async ({ data }: Input) => fn({ data: schema ? schema.parse(data) : data })
      },
    }
    return chain
  },
}))
const { list, access, optionalAuth, actor } = vi.hoisted(() => ({
  list: vi.fn(),
  access: vi.fn(),
  optionalAuth: vi.fn(),
  actor: vi.fn(),
}))
vi.mock('@/lib/server/domains/posts/post.public', () => ({
  listPublicPosts: list,
  getAllUserVotedPostIds: vi.fn(),
}))
vi.mock('../portal-access', () => ({ resolvePortalAccessForRequest: access }))
vi.mock('../auth-helpers', () => ({
  getOptionalAuth: optionalAuth,
  policyActorFromAuth: actor,
  requireAuth: vi.fn(),
  hasAuthCredentials: vi.fn(),
}))
vi.mock('@quackback/db/client', () => ({
  createDb: () => {
    throw new Error('Unit tests must not open a database')
  },
}))
import { listPublicPostsFn } from '../public-posts'

beforeEach(() => {
  vi.clearAllMocks()
  access.mockResolvedValue({ granted: true })
  optionalAuth.mockResolvedValue({ session: 'current-session' })
  actor.mockResolvedValue({ type: 'anonymous' })
  list.mockResolvedValue({ items: [], total: -1, hasMore: true, nextCursor: 'exact-server-cursor' })
})

describe('public cursor endpoint', () => {
  it.each([null, 'continuation'])(
    'forwards cursor=%s and the current policy actor',
    async (cursor) => {
      const result = await listPublicPostsFn({ data: { sort: 'new', cursor, boardSlug: 'ideas' } })
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          sort: 'new',
          cursor,
          boardSlug: 'ideas',
          limit: 20,
          actor: { type: 'anonymous' },
        })
      )
      expect(actor).toHaveBeenCalledWith({ session: 'current-session' })
      expect(result.nextCursor).toBe('exact-server-cursor')
    }
  )

  it('keeps the portal-access gate ahead of every cursor query', async () => {
    access.mockResolvedValue({ granted: false })
    const result = await listPublicPostsFn({ data: { sort: 'new', cursor: 'continuation' } })
    expect(result.items).toEqual([])
    expect(result.hasMore).toBe(false)
    expect(list).not.toHaveBeenCalled()
    expect(optionalAuth).not.toHaveBeenCalled()
  })

  it('rejects oversized cursors before reaching storage', async () => {
    await expect(
      listPublicPostsFn({ data: { sort: 'new', cursor: 'x'.repeat(513) } })
    ).rejects.toThrow()
    expect(list).not.toHaveBeenCalled()
  })
})
