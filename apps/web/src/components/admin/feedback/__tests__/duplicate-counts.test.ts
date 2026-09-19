// @vitest-environment happy-dom
import { createElement, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId, type PostId } from '@quackback/ids'
import { useMergeSuggestionCounts } from '@/lib/client/hooks/use-merge-suggestion-counts'
import { mergeSuggestionQueries } from '@/lib/client/queries/signals'
import { useSuggestionActions } from '@/components/admin/feedback/suggestions/use-suggestion-actions'
import { useMergePost, useUnmergePost } from '@/lib/client/mutations/post-merge'

const api = vi.hoisted(() => ({
  counts: vi.fn(),
  accept: vi.fn(),
  dismiss: vi.fn(),
  restore: vi.fn(),
  merge: vi.fn(),
  unmerge: vi.fn(),
}))
vi.mock('@/lib/server/functions/merge-suggestions', () => ({
  fetchMergeSuggestionCountsForPostsFn: api.counts,
  getMergeSuggestionsForPostFn: vi.fn(),
  fetchMergeSuggestionSummaryFn: vi.fn(),
}))
vi.mock('@/lib/server/functions/feedback', () => ({
  acceptSuggestionFn: api.accept,
  dismissSuggestionFn: api.dismiss,
  restoreSuggestionFn: api.restore,
  fetchSuggestions: vi.fn(),
  fetchFeedbackSources: vi.fn(),
  fetchIncomingSuggestionCount: vi.fn(),
}))
vi.mock('@/lib/server/functions/posts', () => ({
  fetchInboxPostsForAdmin: vi.fn(),
  fetchPostWithDetails: vi.fn(),
}))
vi.mock('@/lib/server/functions/post-merge', () => ({
  mergePostFn: api.merge,
  unmergePostFn: api.unmerge,
}))

type Page = { items: { id: PostId }[] }
const clients: QueryClient[] = []
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client }, children)
  return { client, wrapper }
}
function page(size = 20): Page {
  return { items: Array.from({ length: size }, () => ({ id: generateId('post') })) }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.counts.mockResolvedValue([])
  for (const fn of [api.accept, api.dismiss, api.restore, api.merge]) fn.mockResolvedValue({})
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  focusManager.setFocused(undefined)
  vi.useRealTimers()
})

describe('inbox duplicate count batches', () => {
  it('submits 1,000 IDs across 50 pages instead of the former 25,500 accumulated IDs', async () => {
    const pages = Array.from({ length: 50 }, () => page())
    const batched = renderHook(({ loaded }) => useMergeSuggestionCounts(loaded), {
      wrapper: setup().wrapper,
      initialProps: { loaded: [] as Page[] },
    })
    for (let count = 1; count <= pages.length; count++) {
      batched.rerender({ loaded: pages.slice(0, count) })
      await waitFor(() => expect(batched.result.current.size).toBe(count * 20))
    }
    expect(api.counts).toHaveBeenCalledTimes(50)
    expect(
      api.counts.mock.calls.reduce((total, [input]) => total + input.data.postIds.length, 0)
    ).toBe(1_000)
    batched.unmount()
    api.counts.mockClear()

    // Execute the former InboxContainer query with the same pages and native
    // QueryClient. This measures submitted IDs, not database/runtime speedup.
    const accumulated = renderHook(
      ({ loaded }) =>
        useQuery(
          mergeSuggestionQueries.countsForPosts(
            loaded.flatMap((batch) => batch.items.map((post) => post.id))
          )
        ),
      { wrapper: setup().wrapper, initialProps: { loaded: [] as Page[] } }
    )
    for (let count = 1; count <= pages.length; count++) {
      accumulated.rerender({ loaded: pages.slice(0, count) })
      await waitFor(() => expect(accumulated.result.current.isSuccess).toBe(true))
    }
    expect(api.counts).toHaveBeenCalledTimes(50)
    expect(
      api.counts.mock.calls.reduce((total, [input]) => total + input.data.postIds.length, 0)
    ).toBe(25_500)
  })

  it('retains known zeros when adding a page, even after the first batch becomes stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const first = page(2)
    const second = page(1)
    const { result, rerender } = renderHook(({ pages }) => useMergeSuggestionCounts(pages), {
      wrapper: setup().wrapper,
      initialProps: { pages: [first] },
    })
    await waitFor(() => expect(result.current.get(first.items[0].id)).toBe(0))
    vi.setSystemTime(Date.now() + 31_000)
    rerender({ pages: [first, second] })
    await waitFor(() => expect(result.current.size).toBe(3))
    expect(api.counts.mock.calls.map(([input]) => input.data.postIds)).toEqual([
      first.items.map((post) => post.id),
      second.items.map((post) => post.id),
    ])
    rerender({ pages: [first, second] })
    expect(api.counts).toHaveBeenCalledTimes(2)
  })

  it('keeps pending and failed batches unknown and drops posts from replaced pages', async () => {
    const first = page(1)
    let resolve!: (counts: { postId: PostId; count: number }[]) => void
    api.counts.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { result, rerender } = renderHook(({ pages }) => useMergeSuggestionCounts(pages), {
      wrapper: setup().wrapper,
      initialProps: { pages: [first] },
    })
    expect(result.current.has(first.items[0].id)).toBe(false)
    await act(async () => resolve([{ postId: first.items[0].id, count: 2 }]))
    await waitFor(() => expect(result.current.get(first.items[0].id)).toBe(2))
    const replacement = page(1)
    api.counts.mockRejectedValueOnce(new Error('offline'))
    rerender({ pages: [replacement] })
    await waitFor(() => expect(api.counts).toHaveBeenCalledTimes(2))
    expect(result.current.size).toBe(0)
  })

  it('refreshes known zeros for incoming suggestions when the existing stale/focus policy runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const pages = [page(1), page(1)]
    const { result } = renderHook(() => useMergeSuggestionCounts(pages), {
      wrapper: setup().wrapper,
    })
    await waitFor(() => expect(result.current.size).toBe(2))
    api.counts.mockImplementation(async ({ data }: { data: { postIds: PostId[] } }) =>
      data.postIds.map((postId) => ({ postId, count: 1 }))
    )
    vi.setSystemTime(Date.now() + 31_000)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => expect([...result.current.values()]).toEqual([1, 1]))
    expect(api.counts).toHaveBeenCalledTimes(4)
  })

  it.each(['accept', 'dismiss', 'restore'] as const)(
    '%s refreshes source, target, and other affected page batches',
    async (action) => {
      const pages = [page(1), page(1), page(1)]
      api.counts.mockImplementation(async ({ data }: { data: { postIds: PostId[] } }) =>
        data.postIds.map((postId) => ({ postId, count: 1 }))
      )
      const { result } = renderHook(
        () => ({
          counts: useMergeSuggestionCounts(pages),
          actions: useSuggestionActions({ suggestionId: 'merge-suggestion', isMerge: true }),
        }),
        { wrapper: setup().wrapper }
      )
      await waitFor(() => expect([...result.current.counts.values()]).toEqual([1, 1, 1]))
      api.counts.mockResolvedValue([])
      act(() => result.current.actions[action]())
      await waitFor(() => expect([...result.current.counts.values()]).toEqual([0, 0, 0]))
      expect(api[action]).toHaveBeenCalledOnce()
      expect(api.counts).toHaveBeenCalledTimes(6)
    }
  )

  it.each(['merge', 'unmerge'] as const)(
    '%s refreshes every active count batch',
    async (action) => {
      const pages = [page(1), page(1), page(1)]
      const duplicatePostId = pages[0].items[0].id
      const canonicalPostId = pages[1].items[0].id
      api.unmerge.mockResolvedValue({
        post: { id: duplicatePostId },
        canonicalPost: { id: canonicalPostId },
      })
      const { result } = renderHook(
        () => ({
          counts: useMergeSuggestionCounts(pages),
          merge: useMergePost(),
          unmerge: useUnmergePost(),
        }),
        { wrapper: setup().wrapper }
      )
      await waitFor(() => expect(result.current.counts.size).toBe(3))
      await act(async () => {
        if (action === 'merge')
          await result.current.merge.mutateAsync({ duplicatePostId, canonicalPostId })
        else await result.current.unmerge.mutateAsync(duplicatePostId)
      })
      await waitFor(() => expect(api.counts).toHaveBeenCalledTimes(6))
    }
  )
})
