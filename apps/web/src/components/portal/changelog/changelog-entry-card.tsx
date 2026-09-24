import { Link } from '@tanstack/react-router'
import { LinkIcon } from '@heroicons/react/24/outline'
import { RichTextContent, isRichTextContent } from '@/components/ui/rich-text-editor'
import {
  ChangelogLinkedPostRow,
  formatChangelogDate,
  type ChangelogLinkedPost,
} from './changelog-shared'
import type { ChangelogId } from '@quackback/ids'
import type { JSONContent } from '@tiptap/react'
import type { TiptapContent } from '@/lib/shared/db-types'
import { cn } from '@/lib/shared/utils'

interface ChangelogEntryCardProps {
  id: ChangelogId
  title: string
  content: string
  contentJson: TiptapContent | null
  publishedAt: string
  linkedPosts: ChangelogLinkedPost[]
  className?: string
}

export function ChangelogEntryCard({
  id,
  title,
  content,
  contentJson,
  publishedAt,
  linkedPosts,
  className,
}: ChangelogEntryCardProps) {
  return (
    <article className={cn('flex gap-8 lg:gap-16', className)}>
      {/* Date sidebar. 11rem holds the longest English date ("September 30,
          2026") on one line even under WCAG 1.4.12 text-spacing overrides. */}
      <div className="hidden md:block w-44 shrink-0 pt-1">
        <time
          dateTime={publishedAt}
          className="text-sm text-muted-foreground"
          data-text-profile="short-copy"
        >
          {formatChangelogDate(publishedAt)}
        </time>
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* Mobile date */}
        <time
          dateTime={publishedAt}
          className="md:hidden text-sm text-muted-foreground mb-4 block"
          data-text-profile="short-copy"
        >
          {formatChangelogDate(publishedAt)}
        </time>

        {/* Title with permalink */}
        <Link
          to="/changelog/$entryId"
          params={{ entryId: id }}
          className="group inline-flex min-h-11 items-center gap-2"
        >
          <h2
            className="text-2xl font-normal group-hover:text-primary transition-colors"
            data-text-origin="user"
          >
            {title}
          </h2>
          <LinkIcon className="h-4 w-4 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
        </Link>

        {/* Rich content body */}
        <div className="mt-4" data-text-origin="user">
          {contentJson && isRichTextContent(contentJson) ? (
            <RichTextContent content={contentJson as JSONContent} />
          ) : (
            <p className="whitespace-pre-wrap">{content}</p>
          )}
        </div>

        {/* Linked posts */}
        {linkedPosts.length > 0 && (
          <div className="mt-6 grid gap-2">
            {linkedPosts.map((post) => (
              <ChangelogLinkedPostRow key={post.id} post={post} />
            ))}
          </div>
        )}
      </div>
    </article>
  )
}
