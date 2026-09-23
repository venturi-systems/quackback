import { Link } from '@tanstack/react-router'
import { FormattedMessage } from 'react-intl'
import { StatusBadge } from '@/components/ui/status-badge'
import type { PostId } from '@quackback/ids'

export interface ChangelogLinkedPost {
  id: PostId
  title: string
  voteCount: number
  boardSlug: string
  status?: {
    name: string
    color: string
  } | null
}

/**
 * Publication date of a changelog entry, e.g. "September 23, 2026".
 *
 * Formatted in UTC so the server render and the browser agree: formatting in
 * the viewer's time zone gave a different day for readers west or east of UTC
 * and a hydration mismatch on the changelog pages.
 */
export function formatChangelogDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * A post shipped by a changelog entry: a link to the post, never a voting
 * control. The vote count is stated in words and the full title wraps
 * instead of being truncated (v6.6 voting and typography rules).
 */
export function ChangelogLinkedPostRow({ post }: { post: ChangelogLinkedPost }) {
  return (
    <Link
      to="/b/$slug/posts/$postId"
      params={{ slug: post.boardSlug, postId: post.id }}
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 rounded-lg border border-border/50 hover:border-border hover:bg-muted/30 transition-all group/post"
    >
      <span
        className="flex-1 min-w-0 text-sm font-medium break-words group-hover/post:text-primary transition-colors"
        data-text-origin="user"
      >
        {post.title}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        <FormattedMessage
          id="portal.changelog.linkedPost.voteCount"
          defaultMessage="{count, plural, one {# vote} other {# votes}}"
          values={{ count: post.voteCount }}
        />
      </span>
      {post.status && (
        <StatusBadge name={post.status.name} color={post.status.color} className="shrink-0" />
      )}
    </Link>
  )
}
