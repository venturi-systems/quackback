import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { FormattedMessage } from 'react-intl'
import { z } from 'zod'
import { RoadmapBoard } from '@/components/public/roadmap-board'
import { portalQueries } from '@/lib/client/queries/portal'

const searchSchema = z.object({
  roadmap: z.string().optional(),
  search: z.string().optional(),
  board: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  segments: z.array(z.string()).optional(),
  sort: z.enum(['votes', 'newest', 'oldest']).optional(),
})

export const Route = createFileRoute('/_portal/roadmap/')({
  validateSearch: searchSchema,
  loader: async ({ context }) => {
    const { queryClient, settings, baseUrl, userRole, session } = context

    const [roadmaps] = await Promise.all([
      queryClient.ensureQueryData(portalQueries.roadmaps()),
      queryClient.ensureQueryData(portalQueries.statuses()),
      queryClient.ensureQueryData(portalQueries.boards()),
      queryClient.ensureQueryData(portalQueries.tags()),
    ])

    return {
      firstRoadmapId: roadmaps[0]?.id ?? null,
      workspaceName: settings?.name ?? 'Venturi',
      baseUrl: baseUrl ?? '',
      userRole: userRole ?? null,
      isAuthenticated: !!session?.user && session.user.principalType !== 'anonymous',
    }
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    const { workspaceName, baseUrl } = loaderData
    const title = `Roadmap - ${workspaceName}`
    const description = `See what ${workspaceName} is working on and what's coming next.`
    const canonicalUrl = baseUrl ? `${baseUrl}/roadmap` : ''
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
  component: RoadmapPage,
})

function RoadmapPage() {
  const { firstRoadmapId, userRole, isAuthenticated } = Route.useLoaderData()
  const { roadmap: selectedRoadmapFromUrl } = Route.useSearch()

  const { data: roadmaps } = useSuspenseQuery(portalQueries.roadmaps())
  const { data: statuses } = useSuspenseQuery(portalQueries.statuses())

  const roadmapStatuses = statuses.filter((s) => s.showOnRoadmap)

  // Use URL param if present, otherwise fall back to first roadmap
  const initialSelectedId = selectedRoadmapFromUrl ?? firstRoadmapId

  const isTeamMember = userRole === 'admin' || userRole === 'member'

  return (
    // Cap at viewport height so a column with many cards scrolls internally
    // instead of pushing the body taller. 7rem ≈ PortalHeader.
    // The board is a data surface, so the page composes across the viewport
    // instead of being capped to a prose container: at max-w-6xl the four status
    // columns needed 1248px of runway but only ever got 1104px, so the last
    // column was clipped by a constant 144px while the dead gutter grew to 40%
    // of a 1920px screen. Heading, toolbar and board all share the page's own
    // left edge so the route stays internally aligned; text measure is capped on
    // the text itself, not on the composition.
    <div className="mx-auto w-full px-4 sm:px-6 py-8 h-[calc(100dvh-7rem)] flex flex-col min-h-0">
      <div className="mb-6 animate-in fade-in duration-200 fill-mode-backwards">
        <h1 className="text-3xl font-bold mb-2">
          <FormattedMessage id="portal.roadmap.title" defaultMessage="Roadmap" />
        </h1>
        <p className="text-muted-foreground">
          <FormattedMessage
            id="portal.roadmap.description"
            defaultMessage="See what we're working on and what's coming next."
          />
        </p>
      </div>

      <div
        className="flex-1 min-h-0 flex flex-col animate-in fade-in duration-300 fill-mode-backwards"
        style={{ animationDelay: '100ms' }}
      >
        <RoadmapBoard
          statuses={roadmapStatuses}
          initialRoadmaps={roadmaps}
          initialSelectedRoadmapId={initialSelectedId}
          isTeamMember={isTeamMember}
          isAuthenticated={isAuthenticated}
        />
      </div>
    </div>
  )
}
