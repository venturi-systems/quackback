import { memo, type KeyboardEventHandler } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { Squares2X2Icon } from '@heroicons/react/24/solid'
import { ArrowsPointingOutIcon } from '@heroicons/react/24/outline'
import { Badge } from '@/components/ui/badge'
import type { RoadmapPostEntry } from '@/lib/shared/types'

interface RoadmapCardProps {
  post: RoadmapPostEntry
  statusId: string
  onClick?: () => void
}

/**
 * Admin roadmap card.
 *
 * Moving a card between columns changes the post's public status, so the move
 * has its own visible, named control: the handle on the left is a native
 * button that starts a keyboard drag with Space or Enter (arrow keys move
 * between columns, Space or Enter drops, Escape cancels). Pointer users can
 * still drag the whole card; a short click on the card body opens the post.
 */
export const RoadmapCard = memo(function RoadmapCard({
  post,
  statusId,
  onClick,
}: RoadmapCardProps) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: post.id,
    data: { type: 'Task', post, statusId },
  })
  // Pointer drags start anywhere on the card; keyboard drags only from the
  // handle, so Enter on the card body keeps opening the post.
  const { onKeyDown, ...pointerListeners } = listeners ?? {}
  const handleKeyDown = onKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className="flex bg-card rounded-lg border border-border/50 shadow-sm transition-opacity duration-150"
      {...pointerListeners}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        onKeyDown={handleKeyDown}
        aria-label={`Move ${post.title} to another status`}
        className="flex w-11 shrink-0 cursor-grab items-center justify-center border-r border-border/50 text-muted-foreground hover:bg-muted/50 active:cursor-grabbing"
      >
        <ArrowsPointingOutIcon className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onClick}
        className="flex flex-1 min-w-0 cursor-pointer text-left hover:bg-card/80"
      >
        <CardContent post={post} />
      </button>
    </div>
  )
})

function CardContent({ post }: { post: RoadmapPostEntry }) {
  return (
    <div className="flex-1 min-w-0 p-4">
      <p className="text-sm font-medium text-foreground leading-snug" data-text-origin="user">
        {post.title}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-xs inline-flex items-center gap-0.5">
          <Squares2X2Icon className="h-3 w-3 text-muted-foreground/40" aria-hidden />
          {post.board.name}
        </Badge>
        <span className="roadmap-card__votes text-xs text-muted-foreground">
          {post.voteCount} {post.voteCount === 1 ? 'vote' : 'votes'}
        </span>
      </div>
    </div>
  )
}

export function RoadmapCardOverlay({ post }: { post: RoadmapPostEntry }) {
  return (
    <div className="flex bg-card rounded-lg border border-border/50 shadow-lg cursor-grabbing w-[320px]">
      <div className="w-11 shrink-0 border-r border-border/50" aria-hidden />
      <CardContent post={post} />
    </div>
  )
}
