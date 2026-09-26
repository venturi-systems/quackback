import { useEffect, type RefObject } from 'react'

/**
 * Keeps keyboard focus on screen while a region changes size.
 *
 * The feedback composer (and the widget's) tweens the height of its panels as
 * it opens and closes. Everything after a panel moves while the tween runs, so
 * a control that took keyboard focus, and that the browser scrolled into view
 * as it did, can be carried off screen before the tween ends: on the feed at
 * 390px, the Search button after the composer ended below the viewport (render
 * check runs 36075134195 and 36089214718). Under prefers-reduced-motion there
 * is no tween (ReducedMotionConfig), so nothing moves. This covers everyone who
 * keeps motion on, without turning the animation off for them.
 *
 * Each time the region resizes, after layout and before paint (a
 * ResizeObserver callback), the scroller that holds the keyboard-focused
 * element is scrolled by the least distance that shows the element whole
 * again. It acts only when:
 *   - focus is keyboard focus (`:focus-visible`);
 *   - the element was wholly in view before the resize, so a reader who
 *     scrolled away on purpose is never pulled back;
 *   - the element fits in view, so a tall editor is never re-aligned under
 *     the caret.
 * Its scroller is the nearest ancestor that scrolls vertically (the widget's
 * panel), or the page. The band it keeps focus in honours the scroller's
 * scroll-padding, which on the portal clears the sticky header.
 *
 * Finding the scroller reads computed styles up the ancestor chain, so it is
 * done when focus moves, after each resize, and when an element between the
 * focused one and its known scroller scrolls (that element has started to
 * scroll). Every other scroll event only re-reads geometry: the scroller's box
 * and the focused element's box.
 */

/** Half a pixel of slack for subpixel layout. */
const SLACK = 0.5

interface Band {
  scroller: Element
  top: number
  bottom: number
}

/** The element that scrolls to show a focused element, with its scroll padding. */
interface Scroller {
  element: Element
  /** The page's own scroller, whose band is the viewport. */
  root: boolean
  paddingTop: number
  paddingBottom: number
}

/**
 * The focused element when it matches :focus-visible; null otherwise. That is
 * focus from the keyboard, and focus on a text field however it arrived:
 * browsers match :focus-visible on text fields for a click too.
 */
function keyboardFocus(doc: Document): Element | null {
  let active: Element | null = doc.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  if (!active || active === doc.body || active === doc.documentElement) return null
  try {
    return active.matches(':focus-visible') ? active : null
  } catch {
    return null
  }
}

/**
 * The scroller that holds the element: the nearest ancestor that scrolls
 * vertically, or the page. Reads computed styles up the ancestor chain.
 */
function scrollerOf(element: Element): Scroller | null {
  const doc = element.ownerDocument
  const view = doc.defaultView
  if (!view) return null
  const padding = (box: Element) => {
    const style = view.getComputedStyle(box)
    return {
      paddingTop: parseFloat(style.scrollPaddingTop) || 0,
      paddingBottom: parseFloat(style.scrollPaddingBottom) || 0,
    }
  }
  for (
    let ancestor = element.parentElement;
    ancestor && ancestor !== doc.body && ancestor !== doc.documentElement;
    ancestor = ancestor.parentElement
  ) {
    const { overflowY } = view.getComputedStyle(ancestor)
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      ancestor.scrollHeight > ancestor.clientHeight
    ) {
      return { element: ancestor, root: false, ...padding(ancestor) }
    }
  }
  return {
    element: doc.scrollingElement ?? doc.documentElement,
    root: true,
    ...padding(doc.documentElement),
  }
}

/**
 * The part of the scroller, in viewport coordinates, where an element shows.
 * Reads geometry only, so it is cheap enough for every scroll event.
 */
function bandIn(scroller: Scroller, doc: Document): Band {
  const viewportBottom = doc.documentElement.clientHeight || doc.defaultView?.innerHeight || 0
  if (scroller.root) {
    return {
      scroller: scroller.element,
      top: scroller.paddingTop,
      bottom: viewportBottom - scroller.paddingBottom,
    }
  }
  const box = scroller.element
  const top = box.getBoundingClientRect().top + box.clientTop
  return {
    scroller: box,
    top: Math.max(top + scroller.paddingTop, 0),
    bottom: Math.min(top + box.clientHeight - scroller.paddingBottom, viewportBottom),
  }
}

/** The part of its scroller, in viewport coordinates, where the element shows. */
function bandOf(element: Element): Band | null {
  const scroller = scrollerOf(element)
  return scroller && bandIn(scroller, element.ownerDocument)
}

function isWhole(rect: DOMRect, band: Band): boolean {
  return rect.top >= band.top - SLACK && rect.bottom <= band.bottom + SLACK
}

/**
 * Scrolls the band's scroller by the least distance that shows the element
 * whole, when it is not whole and fits. Returns whether it scrolled.
 */
function scrollIntoBand(element: Element, band: Band): boolean {
  const rect = element.getBoundingClientRect()
  if (isWhole(rect, band) || rect.height > band.bottom - band.top) return false
  const delta = rect.bottom > band.bottom ? rect.bottom - band.bottom : rect.top - band.top
  band.scroller.scrollBy({ top: delta, behavior: 'instant' })
  return true
}

/**
 * Shows a field that has just taken keyboard focus whole, by the least
 * distance, when it fits. Chromium reveals only the caret of a rich text
 * field that takes focus from Tab, not the field: at 1024px the comment
 * editor on a post took focus with 29px of its 72px on screen and its focus
 * ring below the viewport (render check run 36186271140, both motion
 * settings). Acts only on :focus-visible focus, which for a text field also
 * follows a click; then it moves the page only by the part of the field that
 * was hidden. Returns whether it scrolled.
 */
export function revealKeyboardFocus(element: Element): boolean {
  if (keyboardFocus(element.ownerDocument) !== element) return false
  const band = bandOf(element)
  return band ? scrollIntoBand(element, band) : false
}

/**
 * Watches one region. Returns the function that stops watching it. Exported
 * for tests; components use useKeepFocusInView.
 */
export function keepFocusInView(region: Element): () => void {
  const doc = region.ownerDocument
  const view = doc.defaultView
  if (!view || typeof view.ResizeObserver !== 'function') return () => undefined

  let tracked: Element | null = null
  let scroller: Scroller | null = null
  let wasWhole = false

  // Whether the tracked element is whole in its scroller's band now. Geometry
  // only: this is what most scroll events run.
  const judge = () => {
    const band = tracked && scroller && bandIn(scroller, doc)
    wasWhole = Boolean(tracked && band && isWhole(tracked.getBoundingClientRect(), band))
  }

  // Which element has keyboard focus, which scroller holds it, and where it
  // sits now. Runs when focus moves and after each resize.
  const measure = () => {
    tracked = keyboardFocus(doc)
    scroller = tracked && scrollerOf(tracked)
    judge()
  }

  // Runs whenever anything scrolls (the browser's own reveal of a newly
  // focused element included), so a resize is always judged against where the
  // element was just before it. It measures afresh when keyboard focus changed
  // without a focusin (a key pressed after a pointer focused a button makes
  // the button match :focus-visible), or when the scroll came from an element
  // between the focused one and its known scroller: that element has started
  // to scroll, so it is the scroller now. Otherwise it re-reads geometry only.
  const onScroll = (event: Event) => {
    const focused = keyboardFocus(doc)
    const source = event.target
    const between =
      focused !== null &&
      source instanceof view.Element &&
      source !== scroller?.element &&
      source.contains(focused) &&
      (scroller === null || scroller.root || scroller.element.contains(source))
    if (focused !== tracked || between) measure()
    else judge()
  }

  const onResize = () => {
    const focused = keyboardFocus(doc)
    if (focused && focused === tracked && wasWhole) {
      const band = bandOf(focused)
      if (band) scrollIntoBand(focused, band)
    }
    measure()
  }

  measure()
  const observer = new view.ResizeObserver(onResize)
  observer.observe(region)
  // Scroll events do not bubble; capture sees the page's and every panel's.
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  doc.addEventListener('focusin', measure, true)
  return () => {
    observer.disconnect()
    doc.removeEventListener('scroll', onScroll, { capture: true })
    doc.removeEventListener('focusin', measure, true)
  }
}

/** Keeps keyboard focus in view while the referenced region resizes. */
export function useKeepFocusInView(ref: RefObject<Element | null>): void {
  useEffect(() => {
    const region = ref.current
    return region ? keepFocusInView(region) : undefined
  }, [ref])
}
