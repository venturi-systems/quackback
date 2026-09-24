// @vitest-environment happy-dom
/**
 * `useInfiniteScroll` with `holdWhileFocusFollows`: the signed-in render
 * check's keyboard walk found the portal footer's "Data protection addendum"
 * link focused 4,000px below the viewport on the signed-out feed. Tabbing into
 * the footer brought the sentinel into view, the next page loaded above the
 * focused link and pushed it off screen. A held load must wait until focus
 * returns to the list, a page already loading must leave the focused link where
 * it was, and a list without the option must keep loading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useInfiniteScroll } from '../use-infinite-scroll'

type ObserverCallback = (entries: { isIntersecting: boolean }[]) => void
let observers: ObserverCallback[] = []

class FakeIntersectionObserver {
  constructor(callback: ObserverCallback) {
    observers.push(callback)
  }
  observe() {}
  disconnect() {}
}

function intersect(isIntersecting: boolean) {
  act(() => {
    for (const callback of observers) callback([{ isIntersecting }])
  })
}

function Feed({
  onLoadMore,
  hold,
  isFetching = false,
  hasMore = true,
}: {
  onLoadMore: () => void
  hold: boolean
  isFetching?: boolean
  hasMore?: boolean
}) {
  const sentinelRef = useInfiniteScroll({
    hasMore,
    isFetching,
    onLoadMore,
    holdWhileFocusFollows: hold,
  })
  return (
    <>
      <main>
        <a href="#post">A post</a>
        {/* As in the feed, the sentinel exists only while pages remain. */}
        {hasMore && <div ref={sentinelRef} />}
      </main>
      <footer>
        <a href="#terms">Terms</a>
        <a href="#privacy">Privacy</a>
      </footer>
    </>
  )
}

beforeEach(() => {
  observers = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useInfiniteScroll holdWhileFocusFollows', () => {
  it('loads when the sentinel is in view and nothing below it has focus', () => {
    const onLoadMore = vi.fn()
    render(<Feed onLoadMore={onLoadMore} hold />)
    intersect(true)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('holds while focus is on the footer, then loads when focus returns to the list', () => {
    const onLoadMore = vi.fn()
    const { getByText } = render(<Feed onLoadMore={onLoadMore} hold />)
    act(() => getByText('Terms').focus())
    intersect(true)
    expect(onLoadMore).not.toHaveBeenCalled()

    // Moving between footer links keeps the load held.
    act(() => getByText('Privacy').focus())
    expect(onLoadMore).not.toHaveBeenCalled()

    act(() => getByText('A post').focus())
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('does not load on focus while the sentinel is out of view', () => {
    const onLoadMore = vi.fn()
    const { getByText } = render(<Feed onLoadMore={onLoadMore} hold />)
    intersect(false)
    act(() => getByText('A post').focus())
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('keeps a focused footer link in place when the last page arrives above it', () => {
    const view = document.defaultView!
    const originalScrollBy = view.scrollBy
    const scrollBy = vi.fn()
    view.scrollBy = scrollBy as unknown as typeof view.scrollBy
    try {
      const onLoadMore = vi.fn()
      const { getByText, rerender } = render(<Feed onLoadMore={onLoadMore} hold isFetching />)
      const terms = getByText('Terms')
      terms.scrollIntoView = vi.fn()
      const rect = vi
        .spyOn(terms, 'getBoundingClientRect')
        .mockReturnValue({ top: 600, bottom: 644 } as DOMRect)
      act(() => terms.focus())

      // The page that was loading arrives: 4,000px of posts above the link,
      // and it was the last one, so the sentinel goes away in the same render.
      rect.mockReturnValue({ top: 4600, bottom: 4644 } as DOMRect)
      rerender(<Feed onLoadMore={onLoadMore} hold isFetching={false} hasMore={false} />)
      expect(scrollBy).toHaveBeenCalledWith(0, 4000)
    } finally {
      view.scrollBy = originalScrollBy
    }
  })

  it('keeps loading under footer focus for a list that does not opt in', () => {
    const onLoadMore = vi.fn()
    const { getByText } = render(<Feed onLoadMore={onLoadMore} hold={false} />)
    act(() => getByText('Terms').focus())
    intersect(true)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })
})
