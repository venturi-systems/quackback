'use client'

import { useQuery } from '@tanstack/react-query'
import { FormattedMessage, useIntl } from 'react-intl'
import { Link, useHydrated } from '@tanstack/react-router'
import { LinkIcon } from '@heroicons/react/16/solid'
import { cn } from '@/lib/shared/utils'
import { findSimilarPostsFn, type SimilarPost } from '@/lib/server/functions/public-posts'
import type { PostId } from '@quackback/ids'

/**
 * A related post: a link to it, never a voting control. The vote count is
 * stated in words and the status by name, so neither relies on an upvote
 * chevron or a colored dot alone (v6.6 voting and status-badge rules).
 *
 * The title is a block of its own and the count and status are separate
 * labels, not one sentence: on a narrow post column the status may wrap onto
 * its own line beside nothing, which is a label, not a stranded word.
 */
function SimilarPostRow({ post }: { post: SimilarPost }) {
  return (
    <Link
      to="/b/$slug/posts/$postId"
      params={{ slug: post.boardSlug, postId: post.id }}
      className="flex min-h-11 flex-col justify-center gap-0.5 rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/60"
    >
      <p className="text-foreground/80 break-words" data-text-origin="user">
        {post.title}
      </p>
      <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
        <span className="tabular-nums">
          <FormattedMessage
            id="portal.postDetail.related.voteCount"
            defaultMessage="{count, plural, one {# vote} other {# votes}}"
            values={{ count: post.voteCount }}
          />
        </span>
        {post.status && (
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: post.status.color }}
            />
            <span data-text-origin="user">{post.status.name}</span>
          </span>
        )}
      </span>
    </Link>
  )
}

export function similarPostsQuery(postTitle: string) {
  return {
    queryKey: ['similarPosts', 'detail', postTitle],
    queryFn: () => findSimilarPostsFn({ data: { title: postTitle, limit: 3 } }),
    enabled: postTitle.length >= 5,
    staleTime: 5 * 60_000,
  }
}

interface SimilarPostsSectionProps {
  postTitle: string
  currentPostId: PostId
  className?: string
}

export function SimilarPostsSection({
  postTitle,
  currentPostId,
  className,
}: SimilarPostsSectionProps) {
  const intl = useIntl()
  // The post route prefetches similar posts without awaiting them, so the
  // server usually renders before they arrive while the client hydrates with
  // them already in its cache. Showing them only after hydration keeps the
  // first client render identical to the server's; otherwise React discards
  // and regenerates the whole post page (minified error #418).
  const hydrated = useHydrated()
  const { data: allPosts = [] } = useQuery(similarPostsQuery(postTitle))
  const posts = allPosts.filter((p) => p.id !== currentPostId)

  if (!hydrated || posts.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'mt-6 rounded-lg border border-border/30 bg-muted/20 p-3 animate-in fade-in duration-300',
        className
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 px-1">
        <LinkIcon className="h-3 w-3 text-muted-foreground/70" />
        <h3 className="text-xs font-medium text-muted-foreground">
          {intl.formatMessage({ id: 'portal.postDetail.related', defaultMessage: 'Related' })}
        </h3>
      </div>

      <div className="space-y-0.5">
        {posts.map((post) => (
          <SimilarPostRow key={post.id} post={post} />
        ))}
      </div>
    </div>
  )
}
