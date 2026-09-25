// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { revealFocusedColumn } from '../reveal-focused-column'

function rect(left: number, width: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 900,
    width,
    height: 900,
    toJSON: () => ({}),
  } as DOMRect
}

/**
 * Lays out a 350px board at x = 20 with 280px columns 16px apart, as the render
 * check measured it at 390px. A left-to-right board starts at its left edge;
 * a right-to-left one starts at its right edge, and its scrollLeft runs
 * negative, as in Chromium. Computed styles are stubbed: the layout engine is
 * not what these tests measure.
 */
function board({
  scrollLeft = 0,
  align = 'center',
  direction = 'ltr',
}: { scrollLeft?: number; align?: string; direction?: 'ltr' | 'rtl' } = {}) {
  const styles = new Map<Element, Record<string, string>>()
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    (element: Element) =>
      ({
        getPropertyValue: (name: string) => styles.get(element)?.[name] ?? '',
      }) as CSSStyleDeclaration
  )

  const scroller = document.createElement('div')
  styles.set(scroller, { direction })
  document.body.append(scroller)
  Object.defineProperty(scroller, 'clientWidth', { value: 350 })
  Object.defineProperty(scroller, 'clientLeft', { value: 0 })
  Object.defineProperty(scroller, 'scrollLeft', { value: scrollLeft })
  const scrollTo = vi.fn()
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
  scroller.getBoundingClientRect = () => rect(20, 350)

  const cards = [0, 1, 2].map((index) => {
    const column = document.createElement('div')
    column.setAttribute('data-roadmap-column', '')
    styles.set(column, { 'scroll-snap-align': align })
    const left =
      direction === 'ltr' ? 20 + index * 296 - scrollLeft : 370 - 280 - index * 296 - scrollLeft
    column.getBoundingClientRect = () => rect(left, 280)
    const card = document.createElement('a')
    card.href = `#card-${index}`
    column.append(card)
    scroller.append(column)
    return card
  })
  return { scroller, scrollTo, cards }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('revealFocusedColumn (REQ-31: a focused card stays on screen)', () => {
  it('brings a column that is only partly in view to its centre snap position', () => {
    // Run 36091574101: the second column's cards were focused at x = 341px
    // with the board unmoved, four fifths off a 390px screen.
    const { scroller, scrollTo, cards } = board()
    revealFocusedColumn(scroller, cards[1])
    // Column 2 spans 316-596 on screen; the board's centre is at 195.
    expect(scrollTo).toHaveBeenCalledWith({ left: 261, behavior: 'instant' })
  })

  it('aligns the column start where the columns snap to their start', () => {
    const { scroller, scrollTo, cards } = board({ align: 'start' })
    revealFocusedColumn(scroller, cards[2])
    expect(scrollTo).toHaveBeenCalledWith({ left: 592, behavior: 'instant' })
  })

  it('aligns the column right edge in a right-to-left board that snaps to the start', () => {
    const { scroller, scrollTo, cards } = board({ align: 'start', direction: 'rtl' })
    revealFocusedColumn(scroller, cards[1])
    // Column 2 spans -206 to 74 on screen; the board's start edge is at 370.
    expect(scrollTo).toHaveBeenCalledWith({ left: -296, behavior: 'instant' })
  })

  it('leaves the board alone when the focused column is already whole in view', () => {
    const first = board()
    revealFocusedColumn(first.scroller, first.cards[0])
    expect(first.scrollTo).not.toHaveBeenCalled()

    const scrolled = board({ scrollLeft: 261 })
    revealFocusedColumn(scrolled.scroller, scrolled.cards[1])
    expect(scrolled.scrollTo).not.toHaveBeenCalled()
  })

  it('ignores focus outside any column', () => {
    const { scroller, scrollTo } = board()
    const outside = document.createElement('button')
    scroller.append(outside)
    revealFocusedColumn(scroller, outside)
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
