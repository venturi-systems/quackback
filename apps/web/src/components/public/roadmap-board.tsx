import { useEffect } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useIntl } from 'react-intl'
import { MapIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { PostStatusEntity } from '@/lib/shared/db-types'
import { usePublicRoadmaps, type RoadmapView } from '@/lib/client/hooks/use-roadmaps-query'
import { useSegments } from '@/lib/client/hooks/use-segments-queries'
import { usePillsScroll } from '@/lib/client/hooks/use-pills-scroll'
import { portalQueries } from '@/lib/client/queries/portal'
import { resolveSelectedRoadmapId } from './resolve-selected-roadmap'
import { RoadmapColumn } from './roadmap-column'
import { RoadmapColumnsScrollButton } from './roadmap-columns-scroll-button'
import { revealFocusedColumn } from './reveal-focused-column'
import {
  PublicRoadmapFiltersBar,
  PublicRoadmapToolbarFilterButton,
} from './public-roadmap-filters-bar'
import { PublicRoadmapToolbar } from './public-roadmap-toolbar'
import { RoadmapTabs } from './roadmap-tabs'
import { usePublicRoadmapFilters } from './use-public-roadmap-filters'
import { usePublicRoadmapSelection } from './use-public-roadmap-selection'

interface RoadmapBoardProps {
  statuses: PostStatusEntity[]
  initialRoadmaps?: RoadmapView[]
  initialSelectedRoadmapId?: string | null
  isTeamMember?: boolean
  isAuthenticated?: boolean
}

export function RoadmapBoard({
  statuses,
  initialRoadmaps,
  initialSelectedRoadmapId,
  isTeamMember,
  isAuthenticated,
}: RoadmapBoardProps): React.ReactElement {
  const intl = useIntl()
  const { selectedRoadmapId, setSelectedRoadmap } = usePublicRoadmapSelection()
  const { data: roadmaps } = usePublicRoadmaps({ enabled: !initialRoadmaps })
  const columnsScroll = usePillsScroll()

  const { filters, setFilters, clearFilters, toggleBoard, toggleTag, toggleSegment } =
    usePublicRoadmapFilters()

  const { data: boards } = useSuspenseQuery(portalQueries.boards())
  const { data: tags } = useSuspenseQuery(portalQueries.tags())
  // Segments are admin/member-only — anonymous viewers can't filter on them.
  const { data: segments } = useSegments({ enabled: !!isTeamMember })

  const availableRoadmaps = initialRoadmaps ?? roadmaps ?? []
  // A roadmap id from the URL that names no roadmap this viewer can see
  // (deleted, private, mistyped) falls back to the first one instead of
  // rendering columns whose posts query the server would reject.
  const effectiveSelectedId = resolveSelectedRoadmapId(
    selectedRoadmapId ?? initialSelectedRoadmapId,
    availableRoadmaps
  )
  const selectedRoadmap = availableRoadmaps.find((r) => r.id === effectiveSelectedId)
  const signInRequiredForRoadmapItems =
    !isAuthenticated && availableRoadmaps.length > 0 && (boards?.length ?? 0) === 0

  useEffect(() => {
    if (availableRoadmaps.length > 0 && !selectedRoadmapId) {
      setSelectedRoadmap(availableRoadmaps[0].id)
    }
  }, [availableRoadmaps, selectedRoadmapId, setSelectedRoadmap])

  if (availableRoadmaps.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 animate-in fade-in duration-200 fill-mode-backwards">
        <div className="portal-empty-state text-center">
          <MapIcon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground">
            {intl.formatMessage({
              id: 'portal.roadmap.empty.title',
              defaultMessage: 'No roadmaps available',
            })}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {intl.formatMessage({
              id: 'portal.roadmap.empty.description',
              defaultMessage: "Check back later to see what we're working on.",
            })}
          </p>
          <div className="mt-5 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
            <Button asChild>
              {isTeamMember ? (
                <Link to="/admin/roadmap">Manage roadmap</Link>
              ) : (
                <Link to="/">Browse feedback</Link>
              )}
            </Button>
            {isTeamMember && (
              <Button asChild variant="outline">
                <Link to="/admin/feedback">Create feedback item</Link>
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4">
      {availableRoadmaps.length > 1 && (
        <div className="space-y-2">
          <RoadmapTabs
            roadmaps={availableRoadmaps}
            selectedId={effectiveSelectedId}
            onSelect={setSelectedRoadmap}
          />
          {selectedRoadmap?.description && (
            <Card className="bg-muted/50 border-none shadow-none">
              <CardContent className="py-3 px-4">
                <p className="text-sm text-muted-foreground">{selectedRoadmap.description}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <PublicRoadmapToolbar
        currentSort={filters.sort ?? 'votes'}
        onSortChange={(sort) => setFilters({ sort })}
        currentSearch={filters.search}
        onSearchChange={(search) => setFilters({ search })}
        filterButton={
          <PublicRoadmapToolbarFilterButton
            boards={boards}
            tags={tags}
            segments={isTeamMember ? segments : undefined}
            onToggleBoard={toggleBoard}
            onToggleTag={toggleTag}
            onToggleSegment={isTeamMember ? toggleSegment : undefined}
          />
        }
      />

      <PublicRoadmapFiltersBar
        filters={filters}
        onFiltersChange={setFilters}
        onClearAll={clearFilters}
        boards={boards}
        tags={tags}
        segments={isTeamMember ? segments : undefined}
        onToggleBoard={toggleBoard}
        onToggleTag={toggleTag}
        onToggleSegment={isTeamMember ? toggleSegment : undefined}
      />

      {effectiveSelectedId && (
        <div className="relative flex-1 min-h-0">
          <div
            ref={columnsScroll.ref}
            // A card focused in a column only partly in view must bring its
            // column into view: the browser alone left it mostly off screen.
            onFocus={(event) => revealFocusedColumn(event.currentTarget, event.target)}
            className="flex gap-4 pb-4 h-full overflow-x-auto overflow-y-hidden scrollbar-none snap-x snap-mandatory"
          >
            {statuses.map((status, index) => (
              <div
                key={status.id}
                data-roadmap-column=""
                // flex-1 lets the columns divide the board's runway evenly and
                // widen with the viewport. Without it the wrapper is shrink-to-fit,
                // so every column froze at its 300px min-width and the column's own
                // max-width never engaged at any desktop size.
                className="snap-center sm:snap-start flex flex-col flex-1 animate-in fade-in duration-200 fill-mode-backwards"
                style={{ animationDelay: `${index * 75}ms` }}
              >
                <RoadmapColumn
                  roadmapId={effectiveSelectedId as `roadmap_${string}`}
                  statusId={status.id}
                  title={status.name}
                  color={status.color}
                  filters={filters}
                  signInRequiredForItems={signInRequiredForRoadmapItems}
                />
              </div>
            ))}
          </div>

          {columnsScroll.canScrollLeft && (
            <RoadmapColumnsScrollButton
              direction="left"
              onScroll={() => columnsScroll.scrollBy(-320)}
            />
          )}
          {columnsScroll.canScrollRight && (
            <RoadmapColumnsScrollButton
              direction="right"
              onScroll={() => columnsScroll.scrollBy(320)}
            />
          )}
        </div>
      )}
    </div>
  )
}
