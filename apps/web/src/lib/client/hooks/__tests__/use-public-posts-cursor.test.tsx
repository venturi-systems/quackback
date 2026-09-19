// @vitest-environment happy-dom
import type { PropsWithChildren } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePublicPosts } from '../use-portal-posts-query'

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
  fetchPosts
    .mockReset()
    .mockResolvedValue({ items: [], total: -1, hasMore: false, nextCursor: null })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
})
afterEach(() => {
  cleanup()
  client.clear()
})

describe('newest public feed cursor wiring', () => {
  it('uses the SSR cursor for continuation instead of deriving a page or timestamp', async () => {
    const { result } = renderHook(
      () =>
        usePublicPosts({
          filters: { sort: 'new' },
          initialData: {
            items: [],
            total: -1,
            hasMore: true,
            nextCursor: 'server-exact-microsecond-cursor',
          },
        }),
      { wrapper }
    )
    expect(fetchPosts).not.toHaveBeenCalled()
    expect(result.current.hasNextPage).toBe(true)
    await act(async () => {
      const next = await result.current.fetchNextPage()
      expect(next.error).toBeNull()
      expect(next.data?.pages).toHaveLength(2)
      expect(next.data?.pages[1].hasMore).toBe(false)
    })
    expect(fetchPosts).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sort: 'new',
        cursor: 'server-exact-microsecond-cursor',
        limit: 20,
      }),
    })
    expect(fetchPosts.mock.calls[0][0].data).not.toHaveProperty('page')
    await waitFor(() => expect(result.current.hasNextPage).toBe(false))
  })

  it.each([false, true])(
    'starts at cursor:null without a usable SSR cursor (legacy data=%s)',
    async (legacy) => {
      renderHook(
        () =>
          usePublicPosts({
            filters: { sort: 'new' },
            initialData: legacy ? { items: [], total: -1, hasMore: true } : undefined,
          }),
        { wrapper }
      )
      await waitFor(() => expect(fetchPosts).toHaveBeenCalledOnce())
      expect(fetchPosts.mock.calls[0][0].data).toMatchObject({ sort: 'new', cursor: null })
      expect(fetchPosts.mock.calls[0][0].data).not.toHaveProperty('page')
    }
  )

  it('does not reuse a cursor across filter changes', async () => {
    fetchPosts.mockResolvedValue({
      items: [],
      total: -1,
      hasMore: true,
      nextCursor: 'first-filter-cursor',
    })
    const { result, rerender } = renderHook(
      ({ board }) => usePublicPosts({ filters: { sort: 'new', board } }),
      {
        wrapper,
        initialProps: { board: 'first' },
      }
    )
    await waitFor(() =>
      expect(result.current.data?.pages[0].nextCursor).toBe('first-filter-cursor')
    )
    rerender({ board: 'second' })
    await waitFor(() => expect(fetchPosts).toHaveBeenCalledTimes(2))
    expect(fetchPosts.mock.calls[1][0].data).toMatchObject({ boardSlug: 'second', cursor: null })
  })

  it.each(['top', 'trending'] as const)('keeps %s on integer pages', async (sort) => {
    const { result } = renderHook(
      () =>
        usePublicPosts({
          filters: { sort },
          initialData: { items: [], total: -1, hasMore: true },
        }),
      { wrapper }
    )
    await act(async () => {
      await result.current.fetchNextPage()
    })
    expect(fetchPosts.mock.calls[0][0].data).toMatchObject({ sort, page: 2 })
    expect(fetchPosts.mock.calls[0][0].data).not.toHaveProperty('cursor')
  })

  it('preserves a terminal SSR page without fetching or manufacturing a cursor', () => {
    const { result } = renderHook(
      () =>
        usePublicPosts({
          filters: { sort: 'new' },
          initialData: { items: [], total: -1, hasMore: false, nextCursor: null },
        }),
      { wrapper }
    )
    expect(result.current.hasNextPage).toBe(false)
    expect(fetchPosts).not.toHaveBeenCalled()
  })
})
