import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invalidateQueries, setQueryData, setQueriesData } = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
  setQueriesData: vi.fn(),
}))

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries, setQueryData, setQueriesData }),
}))
vi.mock('@/lib/server/functions/public-posts', () => ({
  toggleVoteFn: vi.fn(),
  createPublicPostFn: vi.fn(),
  userEditPostFn: vi.fn(),
  userDeletePostFn: vi.fn(),
}))
vi.mock('@/lib/client/hooks/use-portal-posts-query', () => ({
  publicPostsKeys: { lists: () => ['publicPosts', 'list'] },
  votedPostsKeys: { byWorkspace: () => ['votedPosts'] },
  postPermissionsKeys: {},
}))
vi.mock('@/lib/client/queries/portal-detail', () => ({ portalDetailQueries: {} }))

import { useCreatePublicPost } from '../portal-posts'

describe('submission refresh respects server moderation and list filters', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['pending', 'published'])(
    'refetches %s submissions without inserting them into unrelated cached boards',
    (moderationState) => {
      const mutation = useCreatePublicPost() as unknown as {
        onSuccess: (post: { id: string; moderationState: string }) => void
      }
      mutation.onSuccess({ id: 'post_submission', moderationState })
      expect(setQueriesData).not.toHaveBeenCalled()
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['publicPosts', 'list'] })
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['portal', 'data'] })

      const updateVotes = setQueryData.mock.calls[0][1] as (old: Set<string>) => Set<string>
      expect(updateVotes(new Set(['post_existing']))).toEqual(
        new Set(['post_existing', 'post_submission'])
      )
    }
  )
})
