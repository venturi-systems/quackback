import { useEffect, useRef } from 'react'

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
   * Hold loading while keyboard focus is on something that follows the
   * sentinel in the document, such as the page footer after a feed. Loading
   * then would insert the next page above the focused element and push it out
   * of view (WCAG 2.4.11). Focus returning to the list or above it resumes
   * loading. Only for a list whose growth moves the content after it.
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

  return sentinelRef
}
