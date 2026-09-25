import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import { useIntl } from 'react-intl'
import { cn } from '@/lib/shared/utils'

interface RoadmapColumnsScrollButtonProps {
  direction: 'left' | 'right'
  onScroll: () => void
}

/**
 * The roadmap board's control for scrolling its columns sideways, shown while
 * more columns lie in that direction.
 *
 * The fade spans the board's full height; the button does not. The board grows
 * with its columns, and it was 3,110px tall at 390px in the render check (run
 * 36091574101). The whole fade used to be the button, so its chevron sat
 * 1,555px down: focused from the last card, the button's focus ring ran under
 * the sticky header and off the bottom of the screen, with no chevron in view.
 *
 * The button is now one 44px target (--ds-component-touch-minimum). Equal
 * sticky insets hold it at the middle of the screen while the board passes
 * behind it; at either end of the board it stops at the board's edge. The fade
 * takes no pointer events, so the cards beneath it stay reachable.
 */
export function RoadmapColumnsScrollButton({
  direction,
  onScroll,
}: RoadmapColumnsScrollButtonProps): React.ReactElement {
  const intl = useIntl()
  const left = direction === 'left'
  const Icon = left ? ChevronLeftIcon : ChevronRightIcon
  return (
    <div
      className={cn(
        'pointer-events-none absolute top-0 bottom-4 z-10 flex w-16 flex-col',
        left
          ? 'start-0 bg-gradient-to-r from-background/70 to-transparent'
          : 'end-0 bg-gradient-to-l from-background/70 to-transparent'
      )}
    >
      <button
        type="button"
        onClick={onScroll}
        aria-label={
          left
            ? intl.formatMessage({
                id: 'portal.roadmap.columns.scrollLeft',
                defaultMessage: 'Scroll columns left',
              })
            : intl.formatMessage({
                id: 'portal.roadmap.columns.scrollRight',
                defaultMessage: 'Scroll columns right',
              })
        }
        className={cn(
          'pointer-events-auto sticky top-[calc(50svh-1.375rem)] bottom-[calc(50svh-1.375rem)] my-auto flex size-11 items-center',
          left ? 'self-start justify-start ps-1' : 'self-end justify-end pe-1'
        )}
      >
        <Icon className="w-5 h-5 text-muted-foreground/70" />
      </button>
    </div>
  )
}
