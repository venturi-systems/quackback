// @vitest-environment happy-dom
import type { PropsWithChildren } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
import { usePublicPosts } from '../use-portal-posts-query'

// DEF-45: the portal feed sent every `status_`-prefixed filter value as a status
// id, and the status id column throws on anything that is not a TypeID, so a
// hand-typed `/?status=status_foo` failed the list request.
const { fetchPosts } = vi.hoisted(() => ({ fetchPosts: vi.fn() }))
vi.mock('@/lib/server/functions/public-posts', () => ({
  listPublicPostsFn: fetchPosts,
  getVotedPostsFn: vi.fn(),
  getPostPermissionsFn: vi.fn(),
}))

let client: QueryClient
const wrapper = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)
beforeEach(() => {
  fetchPosts.mockReset().mockResolvedValue({ items: [], total: 0, hasMore: false })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
})

/** The request data the feed sends for this status filter. */
async function requestFor(status: string[]) {
  renderHook(() => usePublicPosts({ filters: { status } }), { wrapper })
  await waitFor(() => expect(fetchPosts).toHaveBeenCalledOnce())
  return fetchPosts.mock.calls[0][0].data as { statusIds?: string[]; statusSlugs?: string[] }
}

describe('public feed status filter', () => {
  it('sends a well-formed status TypeID as a status id', async () => {
    const id = generateId('status')
    const data = await requestFor([id])
    expect(data.statusIds).toEqual([id])
    expect(data.statusSlugs).toBeUndefined()
  })

  it('matches a status_-prefixed value that is not a status TypeID as a slug', async () => {
    const id = generateId('status')
    const malformed = ['status_foo', 'status_', `${id}x`, id.toUpperCase()]
    const data = await requestFor(malformed)
    expect(data.statusIds).toBeUndefined()
    expect(data.statusSlugs).toEqual(malformed)
  })

  it('splits a mixed filter into ids and slugs', async () => {
    const id = generateId('status')
    const data = await requestFor(['open', id, 'status_foo'])
    expect(data.statusIds).toEqual([id])
    expect(data.statusSlugs).toEqual(['open', 'status_foo'])
  })
})
