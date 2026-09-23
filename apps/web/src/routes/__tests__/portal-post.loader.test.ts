import { beforeEach, describe, expect, it, vi } from 'vitest'

const NOT_FOUND = vi.hoisted(() => ({ isNotFound: true }))

vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  createFileRoute: (_path: string) => (opts: unknown) => ({ options: opts }),
  notFound: () => NOT_FOUND,
}))

vi.mock('@/lib/server/functions/public-posts', () => ({
  getPostPermissionsFn: vi.fn(),
  getVoteSidebarDataFn: vi.fn(),
  getVotedPostsFn: vi.fn(),
  findSimilarPostsFn: vi.fn(),
}))

import { PostNotFoundError } from '@/lib/client/queries/portal-detail'
import { Route } from '../_portal.b.$slug.posts.$postId'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoaderFn = (ctx: any) => Promise<unknown>
const loader = (Route as unknown as { options: { loader: LoaderFn } }).options.loader

const POST_ID = 'post_01m37mvqy3ecwt6yv92z59banr'

function context(postDetail: () => Promise<unknown>, others: () => Promise<unknown>) {
  const ensureQueryData = vi.fn((options: { queryKey: unknown[] }) =>
    options.queryKey[0] === 'portal' && options.queryKey[1] === 'post' ? postDetail() : others()
  )
  return {
    params: { slug: 'features', postId: POST_ID },
    context: {
      queryClient: { ensureQueryData, prefetchQuery: vi.fn() },
      settings: { name: 'Venturi' },
      baseUrl: '',
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// fetchPublicPostDetail answers null for a missing post and for one the viewer
// may not read. Both must reach the 404 page, not the "could not load" error
// page, even when a sibling request (comments, permissions) also fails.
describe('portal post route loader', () => {
  it('answers a missing or unreadable post with notFound()', async () => {
    const ctx = context(
      () => Promise.reject(new PostNotFoundError()),
      () => Promise.reject(new Error('Access denied'))
    )
    await expect(loader(ctx)).rejects.toBe(NOT_FOUND)
  })

  it('keeps other failures as errors', async () => {
    const boom = new Error('database unavailable')
    const ctx = context(
      () => Promise.reject(boom),
      () => Promise.resolve([])
    )
    await expect(loader(ctx)).rejects.toBe(boom)
  })

  it('surfaces a sibling failure when the post itself loaded', async () => {
    const boom = new Error('comments unavailable')
    const ctx = context(
      () => Promise.resolve({ title: 'Dark mode', board: { slug: 'features', name: 'Features' } }),
      () => Promise.reject(boom)
    )
    await expect(loader(ctx)).rejects.toBe(boom)
  })

  it('treats a post from another board as not found', async () => {
    const ctx = context(
      () => Promise.resolve({ title: 'Dark mode', board: { slug: 'bugs', name: 'Bugs' } }),
      () => Promise.resolve([])
    )
    await expect(loader(ctx)).rejects.toBe(NOT_FOUND)
  })
})
