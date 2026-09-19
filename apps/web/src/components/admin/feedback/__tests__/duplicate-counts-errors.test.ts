// @vitest-environment happy-dom
import { createElement, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
import { useMergeSuggestionCounts } from '@/lib/client/hooks/use-merge-suggestion-counts'
import { mergeSuggestionQueries } from '@/lib/client/queries/signals'

const { countPosts, requireAuth, logError } = vi.hoisted(() => ({
  countPosts: vi.fn(),
  requireAuth: vi.fn(),
  logError: vi.fn(),
}))
// Vitest does not run Start's server-function compiler. Adapt its builder to
// call the production validator/handler directly instead of making an HTTP call.
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let schema: { parse(value: unknown): unknown } | undefined
    const chain = {
      validator(value: typeof schema) {
        schema = value
        return chain
      },
      handler(fn: (args: { data: unknown }) => Promise<unknown>) {
        return ({ data }: { data: unknown }) => fn({ data: schema ? schema.parse(data) : data })
      },
    }
    return chain
  },
}))
// Keep the production handler, query factory, and hook connected. Only their
// storage, auth, and logging dependencies are replaced.
vi.mock('@/lib/server/domains/merge-suggestions/merge-suggestion.service', () => ({
  getMergeSuggestionCountsForPosts: countPosts,
  getPendingSuggestionsForPost: vi.fn(),
  getPendingMergeSuggestionSummary: vi.fn(),
}))
vi.mock('@/lib/server/functions/auth-helpers', () => ({ requireAuth }))
vi.mock('@/lib/server/logger', () => ({ logger: { child: () => ({ error: logError }) } }))

let client: QueryClient
beforeEach(() => {
  vi.resetAllMocks()
  requireAuth.mockResolvedValue({})
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
})

describe('duplicate counts server failure boundary', () => {
  it.each(['rejection', 'throw'] as const)(
    'does not cache a storage %s as zero, and recovers',
    async (failure) => {
      const error = new Error('storage unavailable')
      if (failure === 'rejection') countPosts.mockRejectedValueOnce(error)
      else
        countPosts.mockImplementationOnce(() => {
          throw error
        })
      const id = generateId('post')
      const pages = [{ items: [{ id }] }]
      const wrapper = ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client }, children)
      const { result } = renderHook(() => useMergeSuggestionCounts(pages), { wrapper })
      const key = mergeSuggestionQueries.countsForPosts([id]).queryKey

      await waitFor(() => expect(client.getQueryState(key)?.status).toBe('error'))
      expect(result.current.has(id)).toBe(false)
      expect(client.getQueryData(key)).toBeUndefined()
      expect(client.getQueryState(key)?.error).toMatchObject({
        message: 'Unable to load duplicate counts',
        cause: error,
      })
      expect(logError).toHaveBeenCalledWith(
        { err: error },
        'fetch merge suggestion counts for posts failed'
      )
      expect(requireAuth).toHaveBeenCalledWith({ roles: ['admin', 'member'] })

      countPosts.mockResolvedValue([])
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['merge-suggestions'] })
      })
      await waitFor(() => expect(result.current.get(id)).toBe(0))
      expect(client.getQueryState(key)?.status).toBe('success')
    }
  )
})
