import { createFileRoute } from '@tanstack/react-router'
import { useIntl } from 'react-intl'
import { RssIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { ChangelogListPublic } from '@/components/portal/changelog'
import { publicChangelogQueries } from '@/lib/client/queries/changelog'
import { portalGateHead } from '@/lib/shared/route-head'

export const Route = createFileRoute('/_portal/changelog/')({
  loader: async ({ context }) => {
    const { queryClient } = context
    await queryClient.ensureInfiniteQueryData(publicChangelogQueries.list())

    return {
      workspaceName: context.settings?.name ?? 'Venturi',
      baseUrl: context.baseUrl ?? '',
    }
  },
  head: ({ loaderData, matches }) => {
    // Behind the sign-in gate the page shows only the gate, so it takes the
    // gate's title and indexing instead of describing this page (DEF-44).
    const gated = portalGateHead(matches)
    if (gated) return gated
    if (!loaderData) return {}
    const { workspaceName, baseUrl } = loaderData
    const title = `Changelog - ${workspaceName}`
    const description = `Stay up to date with the latest ${workspaceName} product updates and shipped features.`
    const canonicalUrl = baseUrl ? `${baseUrl}/changelog` : ''
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        ...(canonicalUrl ? [{ property: 'og:url', content: canonicalUrl }] : []),
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
      ],
      links: canonicalUrl ? [{ rel: 'canonical', href: canonicalUrl }] : [],
    }
  },
  component: ChangelogPage,
})

function ChangelogPage() {
  const intl = useIntl()

  return (
    <div className="portal-page py-8">
      {/* Same heading scale and lead as the feedback and roadmap pages. */}
      <div className="mb-8 flex items-start justify-between gap-4 animate-in fade-in duration-200 fill-mode-backwards">
        <div className="min-w-0">
          <h1 className="portal-page-title">
            {intl.formatMessage({ id: 'portal.changelog.title', defaultMessage: 'Changelog' })}
          </h1>
          <p className="portal-lead text-muted-foreground">
            {intl.formatMessage({
              id: 'portal.changelog.description',
              defaultMessage:
                'Stay up to date with the latest product updates and shipped features.',
            })}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild className="shrink-0 gap-1.5">
          {/* The label is hidden below sm; aria-label keeps the link named. */}
          <a
            href="/changelog/feed"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={intl.formatMessage({
              id: 'portal.changelog.rssFeed',
              defaultMessage: 'RSS Feed',
            })}
          >
            <RssIcon className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">
              {intl.formatMessage({ id: 'portal.changelog.rssFeed', defaultMessage: 'RSS Feed' })}
            </span>
          </a>
        </Button>
      </div>

      <div
        className="animate-in fade-in duration-300 fill-mode-backwards"
        style={{ animationDelay: '100ms' }}
      >
        <ChangelogListPublic />
      </div>
    </div>
  )
}
