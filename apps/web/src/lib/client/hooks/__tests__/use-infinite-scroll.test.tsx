// @vitest-environment happy-dom
/**
 * `useInfiniteScroll` with `holdWhileFocusFollows`: the signed-in render
 * check's keyboard walk found the portal footer's "Data protection addendum"
 * link focused 4,000px below the viewport on the signed-out feed. Tabbing into
 * the footer brought the sentinel into view, the next page loaded above the
 * focused link and pushed it off screen. A held load must wait until focus
 * returns to the list, and a list without the option must keep loading.
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

function Feed({ onLoadMore, hold }: { onLoadMore: () => void; hold: boolean }) {
  const sentinelRef = useInfiniteScroll({
    hasMore: true,
    onLoadMore,
    holdWhileFocusFollows: hold,
  })
  return (
    <>
      <main>
        <a href="#post">A post</a>
        <div ref={sentinelRef} />
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

  it('keeps loading under footer focus for a list that does not opt in', () => {
    const onLoadMore = vi.fn()
    const { getByText } = render(<Feed onLoadMore={onLoadMore} hold={false} />)
    act(() => getByText('Terms').focus())
    intersect(true)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })
})
