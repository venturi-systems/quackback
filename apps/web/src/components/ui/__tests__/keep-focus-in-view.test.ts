// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { keepFocusInView } from '../keep-focus-in-view'

/**
 * Geometry is stubbed: the layout engine is not what these tests measure. The
 * page is a 390x844 viewport with the portal's sticky-header scroll padding
 * (92px) on the root, as the render check measured it on a phone.
 */
const VIEWPORT_HEIGHT = 844
const ROOT_PADDING_TOP = 92

function rect(top: number, height: number): DOMRect {
  return {
    x: 16,
    y: top,
    left: 16,
    right: 16 + 200,
    top,
    bottom: top + height,
    width: 200,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

const view = document.defaultView as Window & typeof globalThis
const RealResizeObserver = view.ResizeObserver

let resize: (() => void) | null = null
let styles: Map<Element, Partial<CSSStyleDeclaration>>
let rootScrollBy: ReturnType<typeof vi.fn>
let stop: (() => void) | null = null

class FakeResizeObserver {
  constructor(callback: () => void) {
    resize = callback
  }
  observe() {}
  disconnect() {
    resize = null
  }
}

beforeEach(() => {
  styles = new Map()
  view.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  vi.spyOn(view, 'getComputedStyle').mockImplementation(
    (element: Element) =>
      ({
        overflowY: 'visible',
        scrollPaddingTop: 'auto',
        scrollPaddingBottom: 'auto',
        ...styles.get(element),
      }) as CSSStyleDeclaration
  )
  styles.set(document.documentElement, { scrollPaddingTop: `${ROOT_PADDING_TOP}px` })
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: VIEWPORT_HEIGHT,
  })
  rootScrollBy = vi.fn()
  Object.defineProperty(document, 'scrollingElement', {
    configurable: true,
    value: { scrollBy: rootScrollBy },
  })
})

afterEach(() => {
  stop?.()
  stop = null
  document.body.replaceChildren()
  view.ResizeObserver = RealResizeObserver
  vi.restoreAllMocks()
})

/** A region (the composer) and a control after it (the feed's Search button). */
function page({ keyboard = true } = {}) {
  const region = document.createElement('div')
  const control = document.createElement('button')
  control.textContent = 'Search'
  control.matches = ((selector: string) =>
    selector === ':focus-visible' ? keyboard : false) as typeof control.matches
  document.body.append(region, control)
  let top = 790
  let height = 44
  control.getBoundingClientRect = () => rect(top, height)
  stop = keepFocusInView(region)
  return {
    control,
    place(nextTop: number, nextHeight = height) {
      top = nextTop
      height = nextHeight
    },
    /** Focus as Tab gives it, then the browser's own scroll event. */
    focus() {
      control.focus()
      document.dispatchEvent(new Event('scroll'))
    },
  }
}

describe('keepFocusInView', () => {
  it('scrolls the page back by the distance a resize carried keyboard focus below the viewport', () => {
    const { place, focus } = page()
    focus()
    // The composer grows by 70px: the button ends at 904px in an 844px viewport.
    place(860)
    resize?.()
    expect(rootScrollBy).toHaveBeenCalledWith({ top: 60, behavior: 'instant' })
  })

  it('reveals below the sticky header when a resize carries focus above it', () => {
    const { place, focus } = page()
    place(120)
    focus()
    // The composer closes: the button moves up to 40px, under the header.
    place(40)
    resize?.()
    expect(rootScrollBy).toHaveBeenCalledWith({
      top: 40 - ROOT_PADDING_TOP,
      behavior: 'instant',
    })
  })

  it('does nothing while focus stays wholly in view', () => {
    const { place, focus } = page()
    place(300)
    focus()
    place(370)
    resize?.()
    expect(rootScrollBy).not.toHaveBeenCalled()
  })

  it('never pulls back a reader who scrolled the focused element away', () => {
    const { place, focus } = page()
    focus()
    // The reader scrolls down: the button leaves the top of the viewport.
    place(-200)
    document.dispatchEvent(new Event('scroll'))
    // Similar posts arrive and the composer grows.
    place(-130)
    resize?.()
    expect(rootScrollBy).not.toHaveBeenCalled()
  })

  it('leaves pointer focus alone', () => {
    const { place, focus } = page({ keyboard: false })
    focus()
    place(860)
    resize?.()
    expect(rootScrollBy).not.toHaveBeenCalled()
  })

  it('never re-aligns an element taller than the view, such as a long editor', () => {
    const { place, focus } = page()
    place(100, 700)
    focus()
    place(160, 760)
    resize?.()
    expect(rootScrollBy).not.toHaveBeenCalled()
  })

  it('scrolls the nearest scrolling panel, as in the widget, not the page', () => {
    const panel = document.createElement('div')
    styles.set(panel, { overflowY: 'auto' })
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 900 })
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(panel, 'clientTop', { configurable: true, value: 0 })
    panel.getBoundingClientRect = () => rect(60, 500)
    const panelScrollBy = vi.fn()
    panel.scrollBy = panelScrollBy as unknown as typeof panel.scrollBy
    const region = document.createElement('div')
    const control = document.createElement('button')
    control.matches = ((selector: string) =>
      selector === ':focus-visible') as typeof control.matches
    panel.append(region, control)
    document.body.append(panel)
    let top = 500
    control.getBoundingClientRect = () => rect(top, 44)
    stop = keepFocusInView(region)

    control.focus()
    document.dispatchEvent(new Event('scroll'))
    // The panel's visible band ends at 560px; the button moves to 530-574px.
    top = 530
    resize?.()
    expect(panelScrollBy).toHaveBeenCalledWith({ top: 14, behavior: 'instant' })
    expect(rootScrollBy).not.toHaveBeenCalled()
  })

  it('stops watching once disposed', () => {
    const { place, focus } = page()
    focus()
    stop?.()
    stop = null
    place(860)
    resize?.()
    expect(rootScrollBy).not.toHaveBeenCalled()
  })
})
