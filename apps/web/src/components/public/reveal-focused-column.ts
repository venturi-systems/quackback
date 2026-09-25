/**
 * Scroll the roadmap board sideways until the column that holds keyboard focus
 * is wholly in view, at that column's own snap position.
 *
 * The board's columns snap (snap-center on a phone, snap-start from sm up).
 * Left to the browser, a card in a column that was already partly in view got
 * focus without the board moving: at 390px, every card of the second column
 * was focused at x = 341px, 230px wide, in a 390px viewport, so four fifths of
 * the card and its focus ring were off screen (render check run 36091574101,
 * 34 stops). Scrolling to the column's snap position, rather than by the
 * least distance, leaves the snap nothing to undo.
 *
 * Does nothing when focus is outside a column or its column is already whole
 * in view, so focus moving within a column in view never moves the board.
 */
export function revealFocusedColumn(scroller: HTMLElement, focused: Element): void {
  // roadmap-board.tsx marks each column wrapper with data-roadmap-column.
  const column = focused.closest('[data-roadmap-column]')
  if (!column || column === scroller || !scroller.contains(column)) return
  const view = scroller.ownerDocument.defaultView
  if (!view) return

  const box = scroller.getBoundingClientRect()
  const start = box.left + scroller.clientLeft
  const end = start + scroller.clientWidth
  const rect = column.getBoundingClientRect()
  // Half a pixel of slack for subpixel layout.
  if (rect.left >= start - 0.5 && rect.right <= end + 0.5) return

  const align = view.getComputedStyle(column).getPropertyValue('scroll-snap-align')
  const rtl = view.getComputedStyle(scroller).getPropertyValue('direction') === 'rtl'
  let delta: number
  if (align.includes('center')) {
    delta = rect.left + rect.width / 2 - (start + end) / 2
  } else if (rtl) {
    delta = rect.right - end
  } else {
    delta = rect.left - start
  }
  scroller.scrollTo({ left: scroller.scrollLeft + delta, behavior: 'instant' })
}
