import { Link } from '@tanstack/react-router'
import { FormattedMessage } from 'react-intl'
import { Squares2X2Icon } from '@heroicons/react/24/solid'
import { Badge } from '@/components/ui/badge'

interface RoadmapCardProps {
  id: string
  title: string
  voteCount: number
  board: {
    slug: string
    name: string
  }
}

/**
 * Public roadmap card: a link to the post, never a voting control.
 *
 * The roadmap is read-only for visitors, so the card states its vote count in
 * words ("12 votes") instead of drawing an upvote chevron that looks like a
 * button but only navigates. Voting happens on the post page, where the real
 * vote control checks the board's vote permission. The v6.6 roadmap template
 * forbids decorative voting controls on a static roadmap.
 */
export function RoadmapCard({ id, title, voteCount, board }: RoadmapCardProps): React.ReactElement {
  return (
    <Link
      to="/b/$slug/posts/$postId"
      params={{ slug: board.slug, postId: id }}
      className="roadmap-card block bg-[var(--post-card-background)] [border-radius:var(--radius)] border border-[var(--post-card-border)] hover:bg-[var(--accent)] transition-colors"
    >
      <div className="roadmap-card__content min-w-0 p-3">
        <p className="text-sm font-medium text-foreground break-words" data-text-origin="user">
          {title}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge variant="secondary" className="text-xs inline-flex items-center gap-1">
            <Squares2X2Icon className="h-3 w-3 text-muted-foreground" aria-hidden />
            <span data-text-origin="user">{board.name}</span>
          </Badge>
          <span className="roadmap-card__votes text-xs text-muted-foreground">
            <FormattedMessage
              id="portal.roadmap.card.voteCount"
              defaultMessage="{count, plural, one {# vote} other {# votes}}"
              values={{ count: voteCount }}
            />
          </span>
        </div>
      </div>
    </Link>
  )
}
