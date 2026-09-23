import { RichTextContent, isRichTextContent } from '@/components/ui/rich-text-editor'
import {
  ChangelogLinkedPostRow,
  formatChangelogDate,
  type ChangelogLinkedPost,
} from './changelog-shared'
import { EmbedHydration } from '@/components/shared/embed-hydration'
import { BackLink } from '@/components/ui/back-link'
import type { ChangelogId } from '@quackback/ids'
import type { JSONContent } from '@tiptap/react'
import type { TiptapContent } from '@/lib/shared/db-types'

interface ChangelogEntryDetailProps {
  id: ChangelogId
  title: string
  content: string
  contentJson: TiptapContent | null
  publishedAt: string
  linkedPosts: ChangelogLinkedPost[]
}

export function ChangelogEntryDetail({
  title,
  content,
  contentJson,
  publishedAt,
  linkedPosts,
}: ChangelogEntryDetailProps) {
  return (
    <article>
      {/* Back link */}
      <BackLink to="/changelog" className="mb-8">
        Changelog
      </BackLink>

      <div className="flex gap-8 lg:gap-16">
        {/* Date sidebar */}
        <div className="hidden md:block w-40 shrink-0 pt-1">
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

          {/* Title */}
          <h1 className="portal-page-title" data-text-origin="user">
            {title}
          </h1>

          {/* Rich content body */}
          <div className="mt-6" data-text-origin="user">
            {contentJson && isRichTextContent(contentJson) ? (
              <EmbedHydration>
                <RichTextContent content={contentJson as JSONContent} />
              </EmbedHydration>
            ) : (
              <p className="whitespace-pre-wrap">{content}</p>
            )}
          </div>

          {/* Linked posts */}
          {linkedPosts.length > 0 && (
            <section className="mt-8 pt-8 border-t border-border/40">
              <h2 className="text-lg font-medium mb-4">Shipped Features</h2>
              <div className="grid gap-2">
                {linkedPosts.map((post) => (
                  <ChangelogLinkedPostRow key={post.id} post={post} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </article>
  )
}
