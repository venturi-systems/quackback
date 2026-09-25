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
 */

/** Half a pixel of slack for subpixel layout. */
const SLACK = 0.5

interface Band {
  scroller: Element
  top: number
  bottom: number
}

/** The focused element when focus is keyboard focus; null otherwise. */
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

/** The part of its scroller, in viewport coordinates, where the element shows. */
function bandOf(element: Element): Band | null {
  const doc = element.ownerDocument
  const view = doc.defaultView
  if (!view) return null
  const viewportBottom = doc.documentElement.clientHeight || view.innerHeight
  const padding = (box: Element) => {
    const style = view.getComputedStyle(box)
    return {
      top: parseFloat(style.scrollPaddingTop) || 0,
      bottom: parseFloat(style.scrollPaddingBottom) || 0,
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
      const top = ancestor.getBoundingClientRect().top + ancestor.clientTop
      const inner = padding(ancestor)
      return {
        scroller: ancestor,
        top: Math.max(top + inner.top, 0),
        bottom: Math.min(top + ancestor.clientHeight - inner.bottom, viewportBottom),
      }
    }
  }
  const root = padding(doc.documentElement)
  return {
    scroller: doc.scrollingElement ?? doc.documentElement,
    top: root.top,
    bottom: viewportBottom - root.bottom,
  }
}

function isWhole(rect: DOMRect, band: Band): boolean {
  return rect.top >= band.top - SLACK && rect.bottom <= band.bottom + SLACK
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
  let wasWhole = false

  // Where keyboard focus sits now. Runs when focus moves and whenever anything
  // scrolls (the browser's own reveal of a newly focused element included),
  // so a resize is always judged against where the element was just before it.
  const measure = () => {
    tracked = keyboardFocus(doc)
    const band = tracked && bandOf(tracked)
    wasWhole = Boolean(tracked && band && isWhole(tracked.getBoundingClientRect(), band))
  }

  const onResize = () => {
    const focused = keyboardFocus(doc)
    if (focused && focused === tracked && wasWhole) {
      const band = bandOf(focused)
      const rect = focused.getBoundingClientRect()
      if (band && !isWhole(rect, band) && rect.height <= band.bottom - band.top) {
        const delta = rect.bottom > band.bottom ? rect.bottom - band.bottom : rect.top - band.top
        band.scroller.scrollBy({ top: delta, behavior: 'instant' })
      }
    }
    measure()
  }

  measure()
  const observer = new view.ResizeObserver(onResize)
  observer.observe(region)
  // Scroll events do not bubble; capture sees the page's and every panel's.
  doc.addEventListener('scroll', measure, { capture: true, passive: true })
  doc.addEventListener('focusin', measure, true)
  return () => {
    observer.disconnect()
    doc.removeEventListener('scroll', measure, { capture: true })
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
