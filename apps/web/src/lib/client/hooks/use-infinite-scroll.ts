import { useEffect, useLayoutEffect, useRef } from 'react'

interface UseInfiniteScrollOptions {
  /** Whether there are more items to load */
  hasMore: boolean
  /** Whether a fetch is currently in progress */
  isFetching?: boolean
  /** Called when the sentinel enters the viewport */
  onLoadMore: () => void
  /** Root margin for early triggering (default: '100px') */
  rootMargin?: string
  /** Intersection threshold (default: 0) */
  threshold?: number
  /**
   * Keep keyboard focus below the list in view (WCAG 2.4.11), for a list
   * whose growth moves the content after it, such as the page footer after a
   * feed. While focus is on something that follows the sentinel, no new page
   * starts loading; focus returning to the list or above it resumes loading.
   * A page that was already loading and arrives anyway keeps the focused
   * element where it was on screen instead of pushing it out of view.
   */
  holdWhileFocusFollows?: boolean
}

/** True when keyboard focus is on an element after `sentinel` in the document. */
export function focusFollowsSentinel(sentinel: Element): boolean {
  const active = sentinel.ownerDocument.activeElement
  if (!active || active === sentinel.ownerDocument.body || sentinel.contains(active)) return false
  return Boolean(sentinel.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING)
}

export function useInfiniteScroll({
  hasMore,
  isFetching = false,
  onLoadMore,
  rootMargin = '100px',
  threshold = 0,
  holdWhileFocusFollows = false,
}: UseInfiniteScrollOptions) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  // The focused element below the list and its viewport top, while there is
  // one. Kept after the sentinel unmounts: the last page removes it in the
  // same render that inserts that page above the focused element.
  const below = useRef<{ element: Element; top: number } | null>(null)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore) return

    let intersecting = false
    const maybeLoad = () => {
      if (!intersecting || isFetching) return
      if (holdWhileFocusFollows && focusFollowsSentinel(sentinel)) return
      onLoadMore()
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        intersecting = entry.isIntersecting
        maybeLoad()
      },
      { rootMargin, threshold }
    )
    observer.observe(sentinel)

    // A load held while focus was below the list runs once focus comes back.
    const doc = sentinel.ownerDocument
    if (holdWhileFocusFollows) doc.addEventListener('focusin', maybeLoad)
    return () => {
      observer.disconnect()
      if (holdWhileFocusFollows) doc.removeEventListener('focusin', maybeLoad)
    }
  }, [hasMore, isFetching, onLoadMore, rootMargin, threshold, holdWhileFocusFollows])

  // Track where the focused element below the list sits on screen.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !holdWhileFocusFollows || !hasMore) return
    const doc = sentinel.ownerDocument
    const record = () => {
      const active = doc.activeElement
      below.current =
        active && focusFollowsSentinel(sentinel)
          ? { element: active, top: active.getBoundingClientRect().top }
          : null
    }
    record()
    doc.addEventListener('focusin', record)
    // Capture, so a scroll of the page or of any scrolling ancestor counts.
    doc.addEventListener('scroll', record, { capture: true, passive: true })
    return () => {
      doc.removeEventListener('focusin', record)
      doc.removeEventListener('scroll', record, { capture: true })
    }
  }, [hasMore, holdWhileFocusFollows])

  // A page that arrives while focus is below the list is inserted above the
  // focused element. Before the browser paints, scroll by the distance it
  // moved, so it stays exactly where the reader left it.
  useLayoutEffect(() => {
    const recorded = below.current
    if (!holdWhileFocusFollows || isFetching || !recorded) return
    const { element, top } = recorded
    const doc = element.ownerDocument
    if (doc.activeElement !== element || !element.isConnected) return
    const moved = element.getBoundingClientRect().top - top
    if (moved === 0) return
    doc.defaultView?.scrollBy(0, moved)
    // The page may scroll inside a container rather than the window: then
    // bring the focused element back into view the plain way.
    const now = element.getBoundingClientRect()
    if (now.bottom <= 0 || now.top >= doc.documentElement.clientHeight) {
      element.scrollIntoView({ block: 'nearest' })
    }
    below.current = { element, top: element.getBoundingClientRect().top }
  }, [isFetching, holdWhileFocusFollows])

  return sentinelRef
}
