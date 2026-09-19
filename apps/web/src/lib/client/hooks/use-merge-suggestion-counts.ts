import { useQueries } from '@tanstack/react-query'
import type { PostId } from '@quackback/ids'
import { mergeSuggestionQueries } from '@/lib/client/queries/signals'

/** Keep each loaded inbox page in its own cache entry when later pages arrive. */
export function useMergeSuggestionCounts(pages?: { items: { id: PostId }[] }[]) {
  const batches = (pages ?? []).map((page) => page.items.map((post) => post.id))
  const results = useQueries({
    queries: batches.map((postIds) => mergeSuggestionQueries.countsForPosts(postIds)),
  })

  const counts = new Map<PostId, number>()
  for (const [index, result] of results.entries()) {
    if (!result.data) continue
    // The endpoint omits zero counts. Cache those as known zero, while leaving
    // pending/failed batches without data unknown until a successful response.
    for (const postId of batches[index]) counts.set(postId, 0)
    for (const { postId, count } of result.data) counts.set(postId, count)
  }
  return counts
}
