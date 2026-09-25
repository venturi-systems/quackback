import { ArrowPathIcon } from '@heroicons/react/24/solid'
import { useIntl } from 'react-intl'
import { useInfiniteScroll } from '@/lib/client/hooks/use-infinite-scroll'
import { RoadmapCard } from './roadmap-card'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import {
  usePublicRoadmapPosts,
  flattenRoadmapPostEntries,
} from '@/lib/client/hooks/use-roadmap-posts-query'
import type { RoadmapId, StatusId } from '@quackback/ids'
import type { RoadmapFilters } from '@/lib/shared/types'

interface RoadmapColumnProps {
  roadmapId: RoadmapId
  statusId: StatusId
  title: string
  color: string
  filters?: RoadmapFilters
  signInRequiredForItems?: boolean
}

export function RoadmapColumn({
  roadmapId,
  statusId,
  title,
  color,
  filters,
  signInRequiredForItems,
}: RoadmapColumnProps) {
  const intl = useIntl()
  const {
    data,
    isFetching,
    isFetchingNextPage,
    isPlaceholderData,
    hasNextPage,
    fetchNextPage,
    isLoading,
    isPending,
    isError,
    refetch,
  } = usePublicRoadmapPosts({
    roadmapId,
    statusId,
    filters,
  })

  const posts = flattenRoadmapPostEntries(data)
  const total = data?.pages[0]?.total
  const resultsPending = isPending || isLoading || isFetching || isPlaceholderData
  const hasAppliedFilters = Boolean(
    filters?.search || filters?.board?.length || filters?.tags?.length || filters?.segmentIds?.length
  )
  const signInMessage = intl.formatMessage({
    id: 'portal.roadmap.column.empty.signInRequired',
    defaultMessage: 'Sign in to view roadmap items.',
  })
  const resultStatus = isError
    ? ''
    : resultsPending
      ? intl.formatMessage({
          id: 'portal.postDetail.deleteDialog.loading',
          defaultMessage: 'Loading...',
        })
      : signInRequiredForItems && total === 0
        ? signInMessage
        : total !== undefined
          ? intl.formatNumber(total)
          : ''

  const sentinelRef = useInfiniteScroll({
    hasMore: hasNextPage,
    isFetching: isFetchingNextPage,
    onLoadMore: fetchNextPage,
  })

  return (
    // No max-width: the 350px cap kept columns narrow on large screens, which is
    // the "condensed content stranded in dead space" the board is meant to avoid.
    // The min-width only engages below ~1280px, where the board's existing
    // snap-scroll + chevron controls take over.
    <Card className="flex-1 min-w-[280px] flex flex-col h-full">
      <CardHeader className="pb-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
            <CardTitle className="text-base font-semibold">{title}</CardTitle>
          </div>
          {/* When items are hidden behind sign-in the true count is unknown to
              this visitor — a "0" badge would misread as an empty column. */}
          <div role="status" aria-atomic="true" data-testid="roadmap-result-status">
            <span className="sr-only">
              {resultStatus && (
                <>
                  {title}
                  {': '}
                  {resultStatus}
                </>
              )}
            </span>
            {!resultsPending &&
              !isError &&
              total !== undefined &&
              !(signInRequiredForItems && total === 0) && (
                <Badge variant="secondary" className="text-xs" aria-hidden="true">
                  {intl.formatNumber(total)}
                </Badge>
              )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0">
        <ScrollArea className="h-full px-6 pb-6">
          {isError ? (
            <div role="alert" className="py-6">
              <p className="mb-3 text-sm text-muted-foreground">
                {intl.formatMessage({
                  id: 'portal.roadmap.column.loadFailed',
                  defaultMessage: 'These items could not be loaded.',
                })}
              </p>
              <Button type="button" variant="outline" onClick={() => void refetch()}>
                {intl.formatMessage({ id: 'portal.auth.tryAgain', defaultMessage: 'Try again' })}
              </Button>
            </div>
          ) : isLoading || (resultsPending && posts.length === 0) ? (
            <div className="h-full flex items-center justify-center py-8 animate-in fade-in duration-200">
              <ArrowPathIcon className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : posts.length === 0 ? (
            <div className="h-full flex items-center justify-center py-8 animate-in fade-in duration-200">
              <p className="text-sm text-muted-foreground">
                {signInRequiredForItems
                  ? signInMessage
                  : hasAppliedFilters
                    ? intl.formatMessage({
                        id: 'portal.feedback.list.noPostsFiltered',
                        defaultMessage: 'No posts match your filters.',
                      })
                    : intl.formatMessage({
                        id: 'portal.roadmap.column.empty',
                        defaultMessage: 'No items yet',
                      })}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {posts.map((post, index) => (
                <div
                  key={post.id}
                  className="animate-in fade-in duration-200 fill-mode-backwards"
                  style={{ animationDelay: `${Math.min(index * 30, 150)}ms` }}
                >
                  <RoadmapCard
                    id={post.id}
                    title={post.title}
                    voteCount={post.voteCount}
                    board={{ slug: post.board.slug, name: post.board.name }}
                  />
                </div>
              ))}
              {hasNextPage && (
                <div ref={sentinelRef} className="py-2 flex justify-center">
                  {isFetchingNextPage && (
                    <ArrowPathIcon className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </div>
              )}
            </div>
          )}
          <ScrollBar />
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
