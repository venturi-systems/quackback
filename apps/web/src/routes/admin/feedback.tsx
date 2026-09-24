import { createFileRoute, Outlet, useRouteContext } from '@tanstack/react-router'
import { z } from 'zod'
import { useQuery } from '@tanstack/react-query'
import { feedbackQueries } from '@/lib/client/queries/feedback'
import { TabStrip, type TabStripItem } from '@/components/admin/tab-strip'
import type { FeatureFlags } from '@/lib/shared/types/settings'
import {
  searchChoice,
  searchCount,
  searchDate,
  searchId,
  searchIdList,
  searchList,
  searchText,
  searchWhere,
} from '@/lib/shared/search-params'
import { isValidTypeId } from '@quackback/ids'

// Every field falls back instead of throwing, so a hand-edited or pasted
// filter URL (`?board=ideas`, `?minVotes=5`) opens the page instead of
// failing with a 500 (DEF-45). Values that feed the inbox query are also held
// to what it accepts: ids must be TypeIDs of their entity (id columns throw on
// anything else), counts must be whole numbers, and dates must be real dates
// (an invalid Date throws when the query serializes it).
// See lib/shared/search-params.ts.
const searchSchema = z.object({
  board: searchIdList('board'),
  tags: searchIdList('tag'),
  status: searchList(), // status slugs, compared as text
  segments: searchIdList('segment'),
  owner: searchWhere((value) => value === 'unassigned' || isValidTypeId(value, 'principal')),
  search: searchText(),
  dateFrom: searchDate(),
  dateTo: searchDate(),
  minVotes: searchCount(),
  minComments: searchCount(),
  responded: searchChoice(['all', 'responded', 'unresponded']),
  updatedBefore: searchDate(),
  sort: z.enum(['newest', 'oldest', 'votes']).optional().default('newest').catch('newest'),
  hasDuplicates: z.boolean().optional().catch(undefined),
  deleted: z.boolean().optional().catch(undefined),
  // PostModal validates the post id (TypeID or UUID) before any fetch.
  post: searchText(),
  // Roadmap-specific
  roadmap: searchId('roadmap'),
  // Suggestion filters (for incoming sub-route)
  source: searchText(),
  suggestionSort: searchChoice(['newest', 'relevance']),
  suggestionSearch: searchText(),
  suggestionStatus: searchChoice(['pending', 'dismissed']),
})

export const Route = createFileRoute('/admin/feedback')({
  validateSearch: searchSchema,
  component: FeedbackLayout,
})

function FeedbackLayout() {
  const { settings } = useRouteContext({ from: '__root__' })
  const flags = settings?.featureFlags as FeatureFlags | undefined
  const { data: incomingStats } = useQuery(feedbackQueries.incomingCount())
  const incomingCount = incomingStats?.count ?? 0

  const tabs: TabStripItem[] = [
    { label: 'Posts', to: '/admin/feedback', exact: true },
    ...(flags?.aiFeedbackExtraction
      ? [{ label: 'Incoming', to: '/admin/feedback/incoming', badge: incomingCount }]
      : []),
  ]

  return (
    <div className="flex h-full flex-col">
      {tabs.length > 1 && <TabStrip tabs={tabs} />}
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  )
}
