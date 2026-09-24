// @vitest-environment happy-dom
import type { PropsWithChildren } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
import { useInboxPosts } from '../use-inbox-query'

// The inbox's "Unassigned" owner filter reached the list query as the text
// 'unassigned', and the owner id column throws on anything that is not a
// TypeID, so choosing it failed the list. The inbox loader already sent null,
// which selects posts with no owner; the list now sends the same.
const { fetchInbox } = vi.hoisted(() => ({ fetchInbox: vi.fn() }))
vi.mock('@/lib/server/functions/posts', () => ({
  fetchInboxPostsForAdmin: fetchInbox,
  fetchPostWithDetails: vi.fn(),
}))

let client: QueryClient
const wrapper = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)
beforeEach(() => {
  fetchInbox.mockReset().mockResolvedValue({ items: [], nextCursor: null, hasMore: false })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
})

/** The owner id the inbox list sends for this owner filter. */
async function ownerIdSentFor(owner: string | undefined) {
  renderHook(() => useInboxPosts({ filters: { owner } }), { wrapper })
  await waitFor(() => expect(fetchInbox).toHaveBeenCalledOnce())
  const { data } = fetchInbox.mock.calls[0][0] as { data: Record<string, unknown> }
  return { present: 'ownerId' in data, ownerId: data.ownerId }
}

describe('inbox owner filter', () => {
  it('sends "Unassigned" as null, never as text', async () => {
    expect(await ownerIdSentFor('unassigned')).toEqual({ present: true, ownerId: null })
  })

  it('sends an owner principal id as it is', async () => {
    const id = generateId('principal')
    expect((await ownerIdSentFor(id)).ownerId).toBe(id)
  })

  it('sends no owner when the filter is off', async () => {
    expect((await ownerIdSentFor(undefined)).ownerId).toBeUndefined()
  })
})
