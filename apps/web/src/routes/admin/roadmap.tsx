import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { adminQueries } from '@/lib/client/queries/admin'
import { RoadmapAdmin } from '@/components/admin/roadmap-admin'
import { RoadmapModal } from '@/components/admin/roadmap-modal'
import { searchChoice, searchId, searchIdList, searchText } from '@/lib/shared/search-params'

// Every field falls back instead of throwing, so `?board=ideas` opens the
// board instead of failing with a 500 (DEF-45). Id filters keep only
// well-formed ids of their own entity, because the column posts query throws on
// anything else. `post` stays text: RoadmapModal validates it (TypeID or UUID)
// before any fetch. See lib/shared/search-params.ts.
const searchSchema = z.object({
  roadmap: searchId('roadmap'),
  post: searchText(),
  search: searchText(),
  board: searchIdList('board'),
  tags: searchIdList('tag'),
  segments: searchIdList('segment'),
  sort: searchChoice(['votes', 'newest', 'oldest']),
})

export const Route = createFileRoute('/admin/roadmap')({
  validateSearch: searchSchema,
  loader: async ({ context }) => {
    const { queryClient } = context

    const { user, principal } = context as {
      user: NonNullable<typeof context.user>
      principal: NonNullable<typeof context.principal>
      queryClient: typeof context.queryClient
    }

    await Promise.all([
      queryClient.ensureQueryData(adminQueries.roadmapStatuses()),
      queryClient.ensureQueryData(adminQueries.boards()),
      queryClient.ensureQueryData(adminQueries.tags()),
      queryClient.ensureQueryData(adminQueries.segments()),
    ])

    return {
      currentUser: {
        name: user.name,
        email: user.email,
        principalId: principal.id,
      },
    }
  },
  component: RoadmapPage,
})

function RoadmapPage() {
  const { currentUser } = Route.useLoaderData()
  const search = Route.useSearch()

  const roadmapStatusesQuery = useSuspenseQuery(adminQueries.roadmapStatuses())

  return (
    <main className="h-full">
      <RoadmapAdmin statuses={roadmapStatusesQuery.data} currentUser={currentUser} />
      <RoadmapModal postId={search.post} currentUser={currentUser} />
    </main>
  )
}
