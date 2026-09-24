import { createFileRoute, redirect } from '@tanstack/react-router'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { FormattedMessage } from 'react-intl'
import { lazy, Suspense } from 'react'
import { z } from 'zod'
import { Spinner } from '@/components/shared/spinner'
import { Button } from '@/components/ui/button'
import { FeedbackEmptyState } from '@/components/public/feedback/feedback-empty-state'
import { PortalParticipation } from '@/components/public/portal-participation'
import { hasAnyPortalAuthMethod } from '@/components/auth/oauth-buttons'
import { useAuthPopoverSafe } from '@/components/auth/auth-popover-context'
import { portalQueries } from '@/lib/client/queries/portal'
import { votedPostsKeys } from '@/lib/client/hooks/use-portal-posts-query'
import {
  MAX_SEARCH_COUNT,
  searchChoice,
  searchIdList,
  searchList,
  searchText,
} from '@/lib/shared/search-params'

const FeedbackContainer = lazy(() =>
  import('@/components/public/feedback/feedback-container').then((module) => ({
    default: module.FeedbackContainer,
  }))
)

// Every field falls back instead of throwing: this is the public home page, and
// a malformed filter in a pasted URL (`?status=open`, `?sort=hot`,
// `?minVotes=many`) used to answer 500 with the raw zod issue in the page.
// Values that feed the feed query are also held to what the query accepts:
// tag ids must be tag TypeIDs (the tag column throws on anything else, which
// failed the SSR loader), and the vote threshold must fit the integer column.
// See lib/shared/search-params.ts.
const searchSchema = z.object({
  board: searchText(), // board slug, compared as text
  search: searchText(),
  sort: z.enum(['top', 'new', 'trending']).optional().default('trending').catch('trending'),
  status: searchList(), // status slugs, compared as text
  tagIds: searchIdList('tag'),
  minVotes: z.coerce.number().int().min(1).max(MAX_SEARCH_COUNT).optional().catch(undefined),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => !Number.isNaN(new Date(s).getTime()), 'Invalid calendar date')
    .optional()
    .catch(undefined),
  responded: searchChoice(['responded', 'unresponded']),
})

export const Route = createFileRoute('/_portal/')({
  validateSearch: searchSchema,
  // Note: No loaderDeps - loader only runs on initial route load for SSR.
  // Client-side filter changes are handled by FeedbackContainer's usePublicPosts.
  // We access search params via location.search for initial SSR without triggering
  // loader re-execution on client-side filter changes.
  loader: async ({ context, location }) => {
    const { session, settings: org, queryClient } = context

    if (!org) {
      throw redirect({ to: '/onboarding' })
    }

    // The parent route renders the sign-in wall when portal visibility is
    // authenticated, but TanStack still executes matched child loaders. Stop
    // here before any board/post/status query so an anonymous SSR response
    // cannot dehydrate tenant-shaped portal data behind that wall.
    const isRealUser = !!session?.user && session.user.principalType !== 'anonymous'
    const accessGated = org.publicPortalConfig?.portalAccess?.isPrivate === true && !isRealUser
    const welcomeCard = org.publicPortalConfig?.welcomeCard
    if (accessGated) {
      return {
        org,
        baseUrl: context.baseUrl ?? '',
        isEmpty: true,
        session,
        welcomeCard,
        accessGated: true,
      }
    }

    // Parse search params for initial SSR (not using loaderDeps to avoid re-execution)
    const searchParams = location.search as z.infer<typeof searchSchema>

    // Prefetch portal data for SSR with URL filters.
    // User identifier is read from cookie directly in the server function.
    // Client-side filter changes are handled by FeedbackContainer.
    const portalData = await queryClient.ensureQueryData(
      portalQueries.portalData({
        boardSlug: searchParams.board,
        search: searchParams.search,
        sort: searchParams.sort ?? 'trending',
        statusSlugs: searchParams.status?.length ? searchParams.status : undefined,
        tagIds: searchParams.tagIds?.length ? searchParams.tagIds : undefined,
        userId: session?.user?.id,
        minVotes: searchParams.minVotes,
        dateFrom: searchParams.dateFrom,
        responded: searchParams.responded,
      })
    )

    // Seed the votedPosts cache so usePostVote has data during SSR rendering.
    // This ensures vote highlights appear in the server-rendered HTML.
    queryClient.setQueryData(votedPostsKeys.byWorkspace(), new Set(portalData.votedPostIds))

    // Per-board vote/submit gating is server-computed (portalData.boardPermissions);
    // the feed and header read it per board instead of a workspace-wide flag.
    return {
      org,
      baseUrl: context.baseUrl ?? '',
      isEmpty: portalData.boards.length === 0,
      session,
      welcomeCard,
      accessGated: false,
    }
  },
  head: ({ loaderData }) => {
    // Let the authenticated parent gate own title, metadata, and indexing.
    if (!loaderData || loaderData.accessGated) return {}
    const workspaceName = loaderData.org.name
    const { baseUrl } = loaderData
    const title = `Feedback - ${workspaceName}`
    const description = `Submit and vote on feature requests for ${workspaceName}. Help shape what gets built next.`
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        ...(baseUrl ? [{ property: 'og:url', content: baseUrl }] : []),
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
      ],
      links: baseUrl ? [{ rel: 'canonical', href: baseUrl }] : [],
    }
  },
  component: PublicPortalPage,
})

function PublicPortalPage() {
  const loaderData = Route.useLoaderData()
  // The parent gate replaces the outlet, but keep this child fail-closed if
  // router behavior changes or the component is rendered independently.
  if (loaderData.accessGated) return null

  return <AccessiblePublicPortalPage loaderData={loaderData} />
}

function AccessiblePublicPortalPage({
  loaderData,
}: {
  loaderData: ReturnType<typeof Route.useLoaderData>
}) {
  const search = Route.useSearch()
  const { org, session, welcomeCard } = loaderData
  const { userRole, settings, registeredAuthProviders } = Route.useRouteContext()
  const canSignIn = hasAnyPortalAuthMethod(settings?.publicAuthConfig?.oauth ?? {}, {
    registeredAuthProviders,
    oidcProviders: settings?.publicPortalConfig?.oidcProviders,
  })
  const authPopover = useAuthPopoverSafe()
  const openAuthPopover = authPopover?.openAuthPopover

  // Read filters directly from URL for instant updates
  const currentBoard = search.board
  const currentSearch = search.search
  const currentSort = search.sort ?? 'trending'

  // Fetch portal data - uses cached data from loader on initial load,
  // refetches with new filters on client-side navigation.
  // keepPreviousData ensures we show stale data while fetching new data.
  // User identifier is read from cookie directly in the server function.
  const {
    data: portalData,
    isFetching,
    isError,
    refetch,
  } = useQuery({
    ...portalQueries.portalData({
      boardSlug: currentBoard,
      search: currentSearch,
      sort: currentSort,
      statusSlugs: search.status?.length ? search.status : undefined,
      tagIds: search.tagIds?.length ? search.tagIds : undefined,
      userId: session?.user?.id,
      minVotes: search.minVotes,
      dateFrom: search.dateFrom,
      responded: search.responded,
    }),
    placeholderData: keepPreviousData,
  })

  // Show empty state if no boards are visible. Signed-out visitors land here
  // whenever every board requires authentication to view — for them the empty
  // state must route to sign-in, not to admin setup (which they cannot use).
  // Anonymous sessions also populate session.user, so !!session is not the
  // right signed-in signal here (matches feedback-container/portal-header).
  const isRealUser = !!session?.user && session.user.principalType !== 'anonymous'
  if (isError && !portalData) {
    return (
      <section className="portal-shell py-10" role="alert">
        <h1 className="text-3xl mb-3">Feedback could not be loaded</h1>
        <p className="text-muted-foreground mb-5">Try loading the page again.</p>
        <Button type="button" onClick={() => void refetch()} disabled={isFetching}>
          Try again
        </Button>
      </section>
    )
  }
  if (!isFetching && portalData?.boards.length === 0) {
    return (
      <FeedbackEmptyState
        authenticated={isRealUser}
        role={userRole}
        onSignIn={
          canSignIn && openAuthPopover ? () => openAuthPopover({ mode: 'login' }) : undefined
        }
      />
    )
  }

  // Handle initial loading state (should be rare due to SSR)
  if (!portalData) {
    return (
      <div className="portal-shell py-6">
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      </div>
    )
  }

  const user = session?.user ? { name: session.user.name, email: session.user.email } : null

  return (
    <div className="portal-shell py-6">
      <section className="portal-introduction" aria-labelledby="feedback-title">
        <h1 id="feedback-title">
          <FormattedMessage id="portal.header.nav.feedback" defaultMessage="Feedback" />
        </h1>
        <p>
          <FormattedMessage
            id="portal.feedback.introduction"
            defaultMessage="Share an idea, support a request, and follow what the team is working on."
          />
        </p>
        <PortalParticipation />
      </section>
      <Suspense
        fallback={
          <div className="flex justify-center py-16">
            <Spinner size="lg" />
          </div>
        }
      >
        <FeedbackContainer
          workspaceName={org.name}
          workspaceSlug={org.slug}
          boards={portalData.boards}
          posts={portalData.posts.items}
          statuses={portalData.statuses}
          tags={portalData.tags}
          hasMore={portalData.posts.hasMore}
          nextCursor={portalData.posts.nextCursor}
          votedPostIds={portalData.votedPostIds}
          currentBoard={currentBoard}
          currentSearch={currentSearch}
          currentSort={currentSort}
          defaultBoardId={portalData.boards[0]?.id}
          user={user}
          boardPermissions={portalData.boardPermissions}
          welcomeCard={welcomeCard}
        />
      </Suspense>
    </div>
  )
}
