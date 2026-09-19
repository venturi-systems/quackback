// @vitest-environment happy-dom
import { type PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IntlProvider } from 'react-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
import { FeedbackRow } from '../table/feedback-row'
import { PostCard } from '@/components/public/post-card'
import { useUpdatePost } from '@/lib/client/mutations/posts'
import { inboxKeys, usePostDetail } from '@/lib/client/hooks/use-inbox-query'
import { inboxContentPreview } from '@/lib/shared/utils/inbox-preview'
import { contentPreview } from '@/lib/shared/utils/string'
import type { InboxPostPreview } from '@/lib/shared/types/posts'

const { updatePost, fetchPost } = vi.hoisted(() => ({ updatePost: vi.fn(), fetchPost: vi.fn() }))
vi.mock('@/lib/server/functions/posts', () => ({
  updatePostFn: updatePost,
  fetchPostWithDetails: fetchPost,
  fetchInboxPostsForAdmin: vi.fn(),
  changePostStatusFn: vi.fn(),
  changePostBoardFn: vi.fn(),
  updatePostTagsFn: vi.fn(),
  createPostFn: vi.fn(),
  toggleCommentsLockFn: vi.fn(),
  deletePostFn: vi.fn(),
  restorePostFn: vi.fn(),
  proxyVoteFn: vi.fn(),
  removeVoteFn: vi.fn(),
}))
vi.mock('@/lib/server/functions/public-posts', () => ({ toggleVoteFn: vi.fn() }))
vi.mock('@/lib/client/hooks/use-portal-posts-query', () => ({
  votedPostsKeys: { all: ['votedPosts'] },
}))
vi.mock('@/lib/client/hooks/use-roadmap-posts-query', () => ({
  roadmapPostsKeys: { all: ['roadmapPosts'] },
}))
vi.mock('@/lib/client/hooks/use-post-vote', () => ({
  usePostVote: ({ voteCount }: { voteCount: number }) => ({
    voteCount,
    hasVoted: false,
    isPending: false,
    handleVote: vi.fn(),
  }),
}))
vi.mock('@/lib/client/hooks/use-ensure-anon-session', () => ({
  useEnsureAnonSession: () => vi.fn(),
}))

let client: QueryClient
beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
})
const wrapper = ({ children }: PropsWithChildren) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

function postFixture(content: string): InboxPostPreview {
  const boardId = generateId('board')
  return {
    id: generateId('post'),
    boardId,
    title: 'Inbox item',
    excerpt: inboxContentPreview(content),
    statusId: null,
    ownerPrincipalId: null,
    voteCount: 3,
    commentCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    board: { id: boardId, name: 'Ideas', slug: 'ideas' },
    tags: [],
    authorName: null,
  }
}

describe('inbox preview consumers', () => {
  it('renders normalized text verbatim and still opens the selected post', () => {
    const post = postFixture('&lt;b&gt;literal&lt;/b&gt; &amp;lt;still encoded&amp;gt;')
    const onClick = vi.fn()
    const { container, getByText } = render(
      <IntlProvider locale="en">
        <FeedbackRow post={post} statuses={[]} onClick={onClick} />
      </IntlProvider>
    )
    expect(container.querySelector('p')?.textContent).toBe(post.excerpt)
    expect(container.querySelector('p b')).toBeNull()
    fireEvent.click(getByText(post.title))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it.each([
    '<p>**Unchanged** [public preview](https://example.com)</p>',
    '<img src="https://example.com/image.png">',
  ])('preserves legacy full-content rendering for other PostCard callers: %s', (content) => {
    const post = postFixture(content)
    const { container } = render(
      <IntlProvider locale="en">
        <PostCard
          id={post.id}
          title={post.title}
          content={content}
          statusId={null}
          statuses={[]}
          voteCount={3}
          commentCount={0}
          authorName={null}
          createdAt={post.createdAt}
          boardSlug="ideas"
          tags={[]}
          onClick={vi.fn()}
        />
      </IntlProvider>
    )
    expect(container.querySelector('p')?.textContent).toBe(contentPreview(content))
  })

  it('loads full content and rich documents from the existing detail query', async () => {
    const content = '**Full document** '.repeat(500)
    const post = postFixture(content)
    const contentJson = { type: 'doc', content: [{ type: 'text', text: content }] }
    fetchPost.mockResolvedValue({
      id: post.id,
      content,
      contentJson,
      summaryJson: { summary: 'Full summary' },
    })
    const { result } = renderHook(() => usePostDetail({ postId: post.id }), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchPost).toHaveBeenCalledWith({ data: { id: post.id } })
    expect(result.current.data?.content).toBe(content)
    expect(result.current.data?.contentJson).toEqual(contentJson)
    expect(result.current.data?.summaryJson).toEqual({ summary: 'Full summary' })
  })

  it.each([false, true])(
    'keeps list edits bounded and detail edits complete (failure=%s)',
    async (fails) => {
      const post = postFixture('Original excerpt')
      const original = {
        id: post.id,
        title: post.title,
        content: 'Original content',
        contentJson: { type: 'doc' },
        statusId: null,
      }
      const listKey = [...inboxKeys.lists(), {}]
      const list = {
        pages: [{ items: [post], nextCursor: null, hasMore: false }],
        pageParams: [undefined],
      }
      client.setQueryData(listKey, list)
      client.setQueryData(inboxKeys.detail(post.id), original)
      let resolve!: (value: typeof original) => void
      let reject!: (error: Error) => void
      updatePost.mockImplementation(
        () =>
          new Promise((done, fail) => {
            resolve = done
            reject = fail
          })
      )
      const { result } = renderHook(() => useUpdatePost(), { wrapper })
      const content = '<p>**Edited content**</p> '.repeat(500)
      const contentJson = { type: 'doc', content: [{ type: 'text', text: content }] }
      let mutation!: Promise<unknown>
      act(() => {
        mutation = result.current
          .mutateAsync({ postId: post.id, title: 'Edited', content, contentJson })
          .catch((error) => error)
      })
      await waitFor(() => expect(updatePost).toHaveBeenCalledOnce())
      const cached = client.getQueryData<typeof list>(listKey)!.pages[0].items[0]
      expect(cached.excerpt).toBe(inboxContentPreview(content))
      expect(cached).not.toHaveProperty('content')
      expect(cached).not.toHaveProperty('contentJson')
      expect(client.getQueryData<typeof original>(inboxKeys.detail(post.id))?.content).toBe(content)
      expect(client.getQueryData<typeof original>(inboxKeys.detail(post.id))?.contentJson).toEqual(
        contentJson
      )
      await act(async () => {
        if (fails) reject(new Error('Save failed'))
        else resolve({ ...original, title: 'Edited', content, contentJson })
        await mutation
      })
      if (fails) {
        expect(client.getQueryData(listKey)).toEqual(list)
        expect(client.getQueryData(inboxKeys.detail(post.id))).toEqual(original)
      } else {
        expect(client.getQueryData<typeof list>(listKey)!.pages[0].items[0].excerpt).toBe(
          inboxContentPreview(content)
        )
        expect(client.getQueryData<typeof original>(inboxKeys.detail(post.id))?.content).toBe(
          content
        )
      }
    }
  )
})
