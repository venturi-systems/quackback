import { useIntl } from 'react-intl'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import { usePillsScroll } from '@/lib/client/hooks/use-pills-scroll'
import { cn } from '@/lib/shared/utils'

interface RoadmapTabItem {
  id: string
  name: string
}

interface RoadmapTabsProps {
  roadmaps: RoadmapTabItem[]
  selectedId: string | null | undefined
  onSelect: (id: string) => void
}

/** Horizontal scrolling tab strip for switching between roadmaps. */
export function RoadmapTabs({ roadmaps, selectedId, onSelect }: RoadmapTabsProps) {
  const intl = useIntl()
  const pills = usePillsScroll()

  return (
    <div className="relative">
      <div
        ref={pills.ref}
        className="flex gap-1 overflow-x-auto scrollbar-none px-1 pb-0.5"
        role="tablist"
        aria-label={intl.formatMessage({
          id: 'portal.roadmap.tabs.aria',
          defaultMessage: 'Roadmaps',
        })}
      >
        {roadmaps.map((roadmap) => {
          const isActive = selectedId === roadmap.id
          // No forced single line (v6.6): a tab keeps its full label on one line
          // while it fits (shrink-0 in a scrollable row). A longer label reflows
          // inside the tab instead of being clipped or pushed past the row. The
          // tab stops short of the row by the width of both scroll affordances
          // (each ps-0.5 + w-4 + pe-6 = 2.625rem, and at least the touch minimum
          // on a coarse pointer), so a scroll position always shows a wrapped
          // label whole, clear of the fading arrow overlays.
          // The 24px token radius draws the same pill as rounded-full for a tab
          // up to 48px tall (one or two lines at the default text size) and
          // keeps the corners of a taller, wrapped tab clear of its text.
          // Roadmap names are written by admins, so the label is marked as user
          // text for the design text checker.
          return (
            <button
              key={roadmap.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(roadmap.id)}
              className={cn(
                'inline-flex max-w-[calc(100%_-_2*max(2.625rem,var(--ds-component-touch-minimum)))] items-center rounded-(--ds-primitive-dimension-radius-24) text-sm px-3 py-1 pointer-coarse:min-h-(--ds-component-touch-minimum) transition-colors shrink-0',
                isActive
                  ? 'bg-foreground/10 text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <span className="min-w-0 break-words" data-text-origin="user">
                {roadmap.name}
              </span>
            </button>
          )
        })}
      </div>

      {pills.canScrollLeft && (
        <button
          type="button"
          onClick={() => pills.scrollBy(-160)}
          aria-label={intl.formatMessage({
            id: 'portal.roadmap.tabs.scrollLeft',
            defaultMessage: 'Scroll left',
          })}
          className="absolute start-0 top-0 bottom-0.5 flex items-center ps-0.5 pe-6 bg-gradient-to-r from-background via-background/80 to-transparent"
        >
          <ChevronLeftIcon className="w-4 h-4 text-muted-foreground" />
        </button>
      )}
      {pills.canScrollRight && (
        <button
          type="button"
          onClick={() => pills.scrollBy(160)}
          aria-label={intl.formatMessage({
            id: 'portal.roadmap.tabs.scrollRight',
            defaultMessage: 'Scroll right',
          })}
          className="absolute end-0 top-0 bottom-0.5 flex items-center pe-0.5 ps-6 bg-gradient-to-l from-background via-background/80 to-transparent"
        >
          <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}
