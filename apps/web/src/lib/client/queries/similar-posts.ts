import { findSimilarPostsFn } from '@/lib/server/functions/public-posts'

export function similarPostsQuery(postTitle: string) {
  return {
    queryKey: ['similarPosts', 'detail', postTitle],
    queryFn: () => findSimilarPostsFn({ data: { title: postTitle, limit: 3 } }),
    enabled: postTitle.length >= 5,
    staleTime: 5 * 60_000,
  }
}
