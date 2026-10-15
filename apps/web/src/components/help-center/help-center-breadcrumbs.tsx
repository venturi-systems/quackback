import { Link } from '@tanstack/react-router'
import { ChevronRightIcon } from '@heroicons/react/16/solid'

export interface BreadcrumbItem {
  label: string
  href?: string
}

interface HelpCenterBreadcrumbsProps {
  items: BreadcrumbItem[]
  /**
   * Whether the last item names the page the reader is on. When true (the
   * default), the last item renders as emphasized text even if it has an href.
   * Pass false when the page shows its own title elsewhere, as the article page
   * does in its h1: the trail then ends at the parent category, which keeps
   * its link so the reader can go back to it.
   */
  currentIsLast?: boolean
}

export function HelpCenterBreadcrumbs({ items, currentIsLast = true }: HelpCenterBreadcrumbsProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1.5 text-sm text-muted-foreground"
    >
      {items.map((item, index) => {
        const isCurrent = currentIsLast && index === items.length - 1
        return (
          <span key={item.label} className="flex items-center gap-1.5">
            {index > 0 && <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" />}
            {isCurrent || !item.href ? (
              <span className={isCurrent ? 'text-foreground font-medium' : undefined}>
                {item.label}
              </span>
            ) : (
              <Link to={item.href} className="hover:text-foreground transition-colors">
                {item.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
