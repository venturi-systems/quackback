/**
 * Keyboard walk over every route in the render plan.
 *
 * For each route, as its identity, in each of its contexts (plan.ts
 * walkContextsFor: a 390px coarse-pointer phone, a 1440px fine-pointer
 * desktop, and a coarse-pointer walk at the width where a planned surface first
 * renders, such as the post sidebar at 1024px; each of them once with motion
 * on and once with prefers-reduced-motion: reduce), this presses Tab from the
 * top of the page until focus leaves the document, then Shift+Tab back. Every
 * stop of both walks is recorded, with the elements reached in only one
 * direction, and a route fails when:
 *
 *   - a surface the plan names for it is missing (the lane would otherwise
 *     measure a page that no longer shows what it exists to measure);
 *   - the session is not the identity the plan says (a silent sign-out would
 *     otherwise turn the signed-in check into a signed-out one);
 *   - a stop shows no visible focus indicator (on the element, beside it, or
 *     on the frame that tightly encloses it), is not :focus-visible, has no
 *     box on screen, or is entirely covered by another element (WCAG 2.4.7,
 *     2.4.11);
 *   - less than half of a stop's box is on screen (the reader cannot tell
 *     what has focus). Tab scrolls a focused element that fits into full view,
 *     so one found mostly outside the viewport moved after it took focus, or
 *     cannot fit on the screen. A stop that is only partly outside is recorded
 *     (`visibility: 'clipped'`, with its `onScreen` share) and counted in the
 *     summary for review;
 *   - focus moves backwards in document order, or any element carries a
 *     positive tabindex (WCAG 2.4.3);
 *   - focus cycles inside the page without ever leaving it, or never ends
 *     (WCAG 2.1.2);
 *   - a target is smaller than the design system's touch minimum
 *     (--ds-component-touch-minimum, 44px) on the coarse pointer, or than
 *     WCAG 2.5.8's 24px on the fine pointer. Inline links inside a sentence
 *     and unstyled native user-agent controls are the only exemptions, both
 *     from WCAG 2.5.8; each exemption is recorded on its stop.
 *
 * Every result is written to $RENDER_OUT_DIR/keyboard before the assertion, so
 * the job summary and the uploaded artifact show the evidence of a failure.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import {
  KEYBOARD_DIR,
  REVIEW_DIR,
  ROUTES,
  readPlan,
  walkContextsFor,
  type RouteSpec,
  type SurfaceProbe,
  type WalkContext,
} from './plan'
import { resolutionFor } from './review-resolutions'

/** Tab presses per direction before the walk is declared endless. */
const MAX_STOPS = 400

/** Consecutive presses allowed inside one iframe before it counts as a trap. */
const MAX_IFRAME_PRESSES = 60

type FindingKind =
  | 'surface-missing'
  | 'identity'
  | 'http-status'
  | 'page-error'
  | 'pointer-emulation'
  | 'focus-not-visible'
  | 'focus-obscured'
  | 'focus-clipped'
  | 'focus-order'
  | 'positive-tabindex'
  | 'focus-trap'
  | 'walk-incomplete'
  | 'target-size'

interface Finding {
  kind: FindingKind
  direction?: 'forward' | 'reverse'
  stop?: number
  selector?: string
  name?: string
  detail: string
}

interface TargetResult {
  width: number
  height: number
  via: 'element' | 'label'
  ok: boolean
  rule: 'size' | 'hit-area' | 'spacing' | 'inline-exception' | 'user-agent-control' | null
}

type Visibility = 'visible' | 'no-box' | 'offscreen' | 'covered' | 'clipped'

interface Occluder {
  selector: string
  slot: string | null
  state: string | null
  opacity: string
  animation: string
  rect: { x: number; y: number; width: number; height: number }
}

interface StopResult {
  kind: 'stop'
  /**
   * The element's identity within this page: the same element carries the
   * same key in the forward and the reverse walk, even when a node inserted
   * elsewhere (a portal, a loaded page) changes its structural selector.
   */
  key: number
  selector: string
  tag: string
  role: string | null
  name: string
  focusVisible: boolean
  indicator: string[]
  target: TargetResult
  visibility: Visibility
  occluders?: Occluder[]
  screenshot?: string
  /** Share of the box's area inside the viewport, 0 to 1, two decimals. */
  onScreen: number
  /**
   * Present when the element moved on screen, or the page scrolled, between
   * the walk first reading the stop and measuring it (after the element's
   * animations settle): dy is the element's move in CSS px, scrollDy the
   * page's. Evidence for review.
   */
  movedAfterFocus?: { dy: number; scrollDy: number }
  order: 'first' | 'in-order' | 'out-of-order'
  rect: { x: number; y: number; width: number; height: number }
}

type StepResult =
  | StopResult
  | { kind: 'exit' }
  | { kind: 'iframe' }
  | { kind: 'repeat'; seenIndex: number; selector: string }

interface WalkResult {
  direction: 'forward' | 'reverse'
  end: 'exit' | 'wrap' | 'trap' | 'limit'
  detail?: string
  stops: StopResult[]
}

interface WalkerApi {
  settleAndStep(direction: 'forward' | 'reverse'): Promise<StepResult>
  reset(): void
  positiveTabindex(): string[]
  pointerCoarse(): boolean
  initialFocus(): string | null
}

declare global {
  interface Window {
    __renderWalk?: WalkerApi
  }
}

/**
 * Installed into the page. Self-contained: Playwright serialises it, so it may
 * not reference anything outside its own body.
 */
function installWalker(opts: { minTarget: number; pointer: 'coarse' | 'fine' }): void {
  const FOCUSABLE =
    'a[href],area[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable]'
  type Snapshot = Record<
    'outline' | 'boxShadow' | 'background' | 'border' | 'color' | 'decoration',
    string
  >
  const snap = (el: Element): Snapshot => {
    const s = getComputedStyle(el)
    return {
      outline: [s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset].join(' '),
      boxShadow: s.boxShadow,
      background: s.backgroundColor,
      border: [
        s.borderTopColor,
        s.borderRightColor,
        s.borderBottomColor,
        s.borderLeftColor,
        s.borderTopWidth,
      ].join(' '),
      color: s.color,
      decoration: [s.textDecorationLine, s.textDecorationThickness, s.textDecorationColor].join(
        ' '
      ),
    }
  }
  // A control's indicator may be drawn by its own frame: a field or card that
  // rings itself with :focus-within or :has() while the control inside it has
  // focus (the composer card, the team comment form). The two nearest
  // ancestors always count. Farther ancestors, up to FRAME_LEVELS out, count
  // only while they tightly enclose the control (at most FRAME_AREA_RATIO
  // times its area), so a style change on a whole region never passes for the
  // focus indicator of one control inside it.
  const FRAME_LEVELS = 6
  const FRAME_AREA_RATIO = 4
  const ancestorsOf = (el: Element): Element[] => {
    const list: Element[] = []
    let ancestor = el.parentElement
    while (ancestor && list.length < FRAME_LEVELS) {
      if (ancestor === document.body || ancestor === document.documentElement) break
      list.push(ancestor)
      ancestor = ancestor.parentElement
    }
    return list
  }
  const related = (el: Element): Element[] => {
    const own = el.getBoundingClientRect()
    const ownArea = Math.max(1, own.width * own.height)
    const list = ancestorsOf(el).filter((ancestor, index) => {
      if (index < 2) return true
      const box = ancestor.getBoundingClientRect()
      return box.width * box.height <= ownArea * FRAME_AREA_RATIO
    })
    list.push(...Array.from(el.children).slice(0, 4))
    const labels = (el as HTMLInputElement).labels
    if (labels) list.push(...Array.from(labels))
    return list
  }
  // Resting styles, taken before any element has focus, so a focused style can
  // be compared with the same element at rest. Every candidate frame is
  // recorded here; whether it encloses the control tightly enough to count is
  // decided when the control has focus, at its layout then.
  const base = new Map<Element, Snapshot>()
  const remember = (el: Element | null | undefined) => {
    if (el && !base.has(el)) base.set(el, snap(el))
  }
  for (const el of Array.from(document.querySelectorAll(FOCUSABLE))) {
    remember(el)
    for (const other of ancestorsOf(el)) remember(other)
    for (const other of Array.from(el.children).slice(0, 4)) remember(other)
    for (const label of Array.from((el as HTMLInputElement).labels ?? [])) remember(label)
  }
  const locator = (start: Element): string => {
    let e: Element | null = start
    if (e.id) return `#${CSS.escape(e.id)}`
    const parts: string[] = []
    while (e && e !== document.body && e !== document.documentElement) {
      const tag = e.localName
      const parent: Element | null = e.parentElement
      const siblings = parent ? Array.from(parent.children).filter((n) => n.localName === tag) : []
      parts.unshift(
        `${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(e) + 1})` : ''}`
      )
      e = parent
    }
    return `body > ${parts.join(' > ')}`
  }
  const transparent = (color: string) =>
    color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color)
  const deepActive = (): Element | null => {
    let a: Element | null = document.activeElement
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement
    return a
  }
  const nameOf = (el: Element): string =>
    (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.textContent ||
      el.getAttribute('placeholder') ||
      (el as HTMLInputElement).value ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
  const indicatorOf = (el: Element): string[] => {
    const reasons: string[] = []
    const s = getComputedStyle(el)
    if (
      s.outlineStyle !== 'none' &&
      parseFloat(s.outlineWidth) > 0 &&
      !transparent(s.outlineColor)
    ) {
      reasons.push('outline')
    }
    const was = base.get(el)
    const now = snap(el)
    if (was) {
      for (const key of Object.keys(now) as (keyof Snapshot)[]) {
        if (key !== 'outline' && now[key] !== was[key]) reasons.push(key)
      }
    } else if (s.boxShadow !== 'none') {
      reasons.push('boxShadow (no resting snapshot)')
    }
    for (const other of related(el)) {
      const b = base.get(other)
      if (!b) continue
      const n = snap(other)
      if (n.outline !== b.outline && !n.outline.startsWith('none')) reasons.push('related outline')
      if (n.boxShadow !== b.boxShadow) reasons.push('related boxShadow')
      if (n.background !== b.background || n.border !== b.border) reasons.push('related surface')
    }
    return Array.from(new Set(reasons))
  }
  const rectOf = (el: Element): { rect: DOMRect; via: 'element' | 'label' } => {
    const rect = el.getBoundingClientRect()
    const labels = (el as HTMLInputElement).labels
    if ((rect.width < 2 || rect.height < 2) && labels && labels.length > 0) {
      return { rect: labels[0].getBoundingClientRect(), via: 'label' }
    }
    return { rect, via: 'element' }
  }
  const hitsElement = (el: Element, x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false
    const hit = document.elementFromPoint(x, y)
    if (!hit) return false
    const labels = Array.from((el as HTMLInputElement).labels ?? [])
    return hit === el || el.contains(hit) || labels.some((label) => label.contains(hit))
  }
  const isInlineLink = (el: Element): boolean => {
    if (el.localName !== 'a' || getComputedStyle(el).display !== 'inline') return false
    const block = el.parentElement
    if (!block) return false
    const around = (block.textContent ?? '').replace(el.textContent ?? '', '')
    return /[\p{L}\p{N}]/u.test(around)
  }
  const isNativeUaControl = (el: Element): boolean =>
    el.localName === 'input' &&
    ['checkbox', 'radio', 'range', 'color', 'file'].includes((el as HTMLInputElement).type) &&
    getComputedStyle(el).appearance !== 'none'
  const targetOf = (el: Element): TargetResultInPage => {
    const { rect, via } = rectOf(el)
    const min = opts.minTarget
    const width = Math.round(rect.width * 10) / 10
    const height = Math.round(rect.height * 10) / 10
    if (Math.min(rect.width, rect.height) >= min - 0.5) {
      return { width, height, via, ok: true, rule: 'size' }
    }
    // A control may extend its hit area beyond its painted box (padding, a
    // pseudo-element). Probe the edges of a min-sized square around its centre.
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const d = min / 2 - 1
    const probes: [number, number][] = [
      [cx - d, cy],
      [cx + d, cy],
      [cx, cy - d],
      [cx, cy + d],
    ]
    if (probes.every(([x, y]) => hitsElement(el, x, y))) {
      return { width, height, via, ok: true, rule: 'hit-area' }
    }
    if (isInlineLink(el)) return { width, height, via, ok: true, rule: 'inline-exception' }
    if (isNativeUaControl(el)) return { width, height, via, ok: true, rule: 'user-agent-control' }
    if (opts.pointer === 'fine') {
      // WCAG 2.5.8 spacing: a 24px circle centred on the undersized target
      // intersects no other target (and no other undersized target's circle).
      const radius = 12
      const others = Array.from(document.querySelectorAll(FOCUSABLE)).filter(
        (other) => other !== el && !el.contains(other) && !other.contains(el)
      )
      const clear = others.every((other) => {
        const r = other.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return true
        const nx = Math.max(r.left, Math.min(cx, r.right))
        const ny = Math.max(r.top, Math.min(cy, r.bottom))
        const toRect = Math.hypot(cx - nx, cy - ny)
        if (toRect < radius) return false
        if (Math.min(r.width, r.height) < 24) {
          const ox = r.left + r.width / 2
          const oy = r.top + r.height / 2
          if (Math.hypot(cx - ox, cy - oy) < radius * 2) return false
        }
        return true
      })
      if (clear) return { width, height, via, ok: true, rule: 'spacing' }
    }
    return { width, height, via, ok: false, rule: null }
  }
  type TargetResultInPage = {
    width: number
    height: number
    via: 'element' | 'label'
    ok: boolean
    rule: 'size' | 'hit-area' | 'spacing' | 'inline-exception' | 'user-agent-control' | null
  }
  const visibilityOf = (
    el: Element
  ): { visibility: Visibility; onScreen: number; occluders?: Occluder[] } => {
    const { rect } = rectOf(el)
    if (rect.width < 1 || rect.height < 1) return { visibility: 'no-box', onScreen: 0 }
    if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) {
      return { visibility: 'offscreen', onScreen: 0 }
    }
    // Sample the part of the box that is on screen. Fractions of the whole box
    // miss it when the box runs past the viewport: a 3,110px button left only
    // two sample points on screen, both under the sticky header (run
    // 36091574101), and a 4,138px one and a Search button 4px on screen left
    // none, which read as visible without a single sample (run 36088534312).
    // Every point below lies inside the viewport, so no stop passes unsampled.
    const left = Math.max(rect.left, 0)
    const top = Math.max(rect.top, 0)
    const right = Math.min(rect.right, innerWidth)
    const bottom = Math.min(rect.bottom, innerHeight)
    const onScreen =
      Math.round((((right - left) * (bottom - top)) / (rect.width * rect.height)) * 100) / 100
    const points = (
      [
        [0.5, 0.5],
        [0.2, 0.2],
        [0.8, 0.2],
        [0.2, 0.8],
        [0.8, 0.8],
      ] as [number, number][]
    ).map(([fx, fy]) => [left + (right - left) * fx, top + (bottom - top) * fy] as [number, number])
    const labels = Array.from((el as HTMLInputElement).labels ?? [])
    const occludingElements = new Set<Element>()
    const covered = points.filter(([x, y]) => {
      const hit = document.elementFromPoint(x, y)
      if (!hit) return false
      if (hit === el || el.contains(hit) || hit.contains(el)) return false
      if (labels.some((label) => label === hit || label.contains(hit) || hit.contains(label))) {
        return false
      }
      occludingElements.add(hit)
      return true
    })
    if (covered.length === points.length) {
      const occluders = Array.from(occludingElements, (hit) => {
        const rect = hit.getBoundingClientRect()
        const style = getComputedStyle(hit)
        return {
          selector: locator(hit),
          slot: hit.getAttribute('data-slot'),
          state: hit.getAttribute('data-state'),
          opacity: style.opacity,
          animation: style.animationName,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
      })
      return { visibility: 'covered', onScreen, occluders }
    }
    // Half a pixel of slack for subpixel layout.
    const outside =
      rect.left < -0.5 ||
      rect.top < -0.5 ||
      rect.right > innerWidth + 0.5 ||
      rect.bottom > innerHeight + 0.5
    return { visibility: outside ? 'clipped' : 'visible', onScreen }
  }

  const visited: Element[] = []
  // Element identity for comparing the two walks. It lives as long as the
  // page, so reset() between the walks keeps it.
  const keys = new WeakMap<Element, number>()
  let nextKey = 0
  const keyOf = (el: Element): number => {
    let key = keys.get(el)
    if (key === undefined) {
      key = nextKey++
      keys.set(el, key)
    }
    return key
  }
  const initial = deepActive()
  const api: WalkerApi = {
    reset() {
      visited.length = 0
    },
    positiveTabindex() {
      return Array.from(document.querySelectorAll('[tabindex]'))
        .filter((el) => (el as HTMLElement).tabIndex > 0)
        .map(locator)
    },
    pointerCoarse() {
      return matchMedia('(pointer: coarse)').matches
    },
    initialFocus() {
      return initial && initial !== document.body && initial !== document.documentElement
        ? locator(initial)
        : null
    },
    async settleAndStep(direction) {
      const el = deepActive()
      if (!el || el === document.body || el === document.documentElement) return { kind: 'exit' }
      // Where focus left the element, for telling a stop the browser never
      // scrolled fully into view from one that moved after it took focus.
      const atFocus = { top: el.getBoundingClientRect().top, scrollY }
      // Let focus transitions finish before reading the focused style.
      const animations = [el, el.parentElement]
        .filter((e): e is Element => Boolean(e))
        .flatMap((e) => e.getAnimations())
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ])
      }
      const seenIndex = visited.indexOf(el)
      if (seenIndex !== -1) {
        if (el.localName === 'iframe' && seenIndex === visited.length - 1) return { kind: 'iframe' }
        return { kind: 'repeat', seenIndex, selector: locator(el) }
      }
      const previous = visited.at(-1)
      let order: 'first' | 'in-order' | 'out-of-order' = 'first'
      if (previous) {
        const position = previous.compareDocumentPosition(el)
        const after = Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING)
        order = (direction === 'forward') === after ? 'in-order' : 'out-of-order'
      }
      visited.push(el)
      const rect = el.getBoundingClientRect()
      const { visibility, onScreen, occluders } = visibilityOf(el)
      const dy = Math.round(rect.top - atFocus.top)
      const scrollDy = Math.round(scrollY - atFocus.scrollY)
      return {
        kind: 'stop',
        key: keyOf(el),
        selector: locator(el),
        tag: el.localName,
        role: el.getAttribute('role'),
        name: nameOf(el),
        focusVisible: el.matches(':focus-visible'),
        indicator: indicatorOf(el),
        target: targetOf(el),
        visibility,
        onScreen,
        ...(occluders ? { occluders } : {}),
        ...(dy || scrollDy ? { movedAfterFocus: { dy, scrollDy } } : {}),
        order,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        },
      }
    },
  }
  window.__renderWalk = api
}

async function walk(
  page: Page,
  direction: 'forward' | 'reverse',
  evidenceName: string
): Promise<WalkResult> {
  await page.evaluate(() => window.__renderWalk!.reset())
  const stops: StopResult[] = []
  let iframePresses = 0
  let capturedFailure = false
  for (let press = 0; press < MAX_STOPS + MAX_IFRAME_PRESSES; press++) {
    await page.keyboard.press(direction === 'forward' ? 'Tab' : 'Shift+Tab')
    const step = await page.evaluate((dir) => window.__renderWalk!.settleAndStep(dir), direction)
    if (step.kind === 'exit') {
      // Starting from outside the page, the first press may itself land
      // outside (browser chrome); only an exit after a stop ends the walk.
      if (stops.length === 0 && press < 2) continue
      return { direction, end: 'exit', stops }
    }
    if (step.kind === 'iframe') {
      iframePresses += 1
      if (iframePresses > MAX_IFRAME_PRESSES) {
        return {
          direction,
          end: 'trap',
          detail: `focus stayed inside an iframe for ${MAX_IFRAME_PRESSES} presses`,
          stops,
        }
      }
      continue
    }
    iframePresses = 0
    if (step.kind === 'repeat') {
      if (step.seenIndex === 0) return { direction, end: 'wrap', stops }
      return {
        direction,
        end: 'trap',
        detail: `focus returned to stop ${step.seenIndex} (${step.selector}) after ${stops.length} stops without leaving the page`,
        stops,
      }
    }
    if (
      !capturedFailure &&
      (step.visibility === 'covered' || (step.visibility === 'clipped' && step.onScreen < 0.5))
    ) {
      fs.mkdirSync(KEYBOARD_DIR, { recursive: true })
      const filename = `${evidenceName}__${direction}__first-visibility-failure.png`
      await page.screenshot({ path: path.join(KEYBOARD_DIR, filename) })
      step.screenshot = filename
      capturedFailure = true
    }
    stops.push(step)
    if (stops.length >= MAX_STOPS) break
  }
  return { direction, end: 'limit', detail: `no end after ${MAX_STOPS} stops`, stops }
}

async function probeSurface(page: Page, surface: SurfaceProbe, width: number): Promise<boolean> {
  if (surface.minWidth && width < surface.minWidth) return true
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const locator = surface.testId
    ? page.getByTestId(surface.testId)
    : surface.role
      ? page.getByRole(surface.role.role, { name: new RegExp(`^${escape(surface.role.name)}`) })
      : surface.text
        ? page.getByText(surface.text, { exact: false })
        : page.locator(surface.css ?? ':root')
  if (surface.state === 'attached') return (await locator.count()) > 0
  return (await locator.filter({ visible: true }).count()) > 0
}

function stopFindings(result: WalkResult, ctx: WalkContext): Finding[] {
  const findings: Finding[] = []
  result.stops.forEach((stop, index) => {
    const at = {
      direction: result.direction,
      stop: index,
      selector: stop.selector,
      name: stop.name,
    }
    // Visibility and target requirements apply to Tab and Shift+Tab alike.
    if (!stop.focusVisible) {
      findings.push({
        ...at,
        kind: 'focus-not-visible',
        detail: 'keyboard focus does not match :focus-visible',
      })
    } else if (stop.indicator.length === 0) {
      findings.push({
        ...at,
        kind: 'focus-not-visible',
        detail:
          'no outline, shadow, colour or surface change on the element, its frame or beside it',
      })
    }
    if (stop.visibility === 'no-box' || stop.visibility === 'offscreen') {
      findings.push({
        ...at,
        kind: 'focus-not-visible',
        detail: `focused element is ${stop.visibility}`,
      })
    } else if (stop.visibility === 'covered') {
      findings.push({
        ...at,
        kind: 'focus-obscured',
        detail: 'focused element is entirely covered',
      })
    } else if (stop.visibility === 'clipped' && stop.onScreen < 0.5) {
      const { x, y, width, height } = stop.rect
      findings.push({
        ...at,
        kind: 'focus-clipped',
        detail: `only ${Math.round(stop.onScreen * 100)}% of the focused element (${width}x${height}px at ${x},${y}) is inside the ${ctx.width}x${ctx.height}px viewport`,
      })
    }
    if (!stop.target.ok) {
      findings.push({
        ...at,
        kind: 'target-size',
        detail: `${stop.target.width}x${stop.target.height}px is below the ${ctx.minTarget}px ${ctx.pointer}-pointer minimum`,
      })
    }
    if (stop.order === 'out-of-order') {
      findings.push({
        ...at,
        kind: 'focus-order',
        detail:
          result.direction === 'forward'
            ? 'Tab moved focus to an element earlier in the document'
            : 'Shift+Tab moved focus to an element later in the document',
      })
    }
  })
  if (result.end === 'trap') {
    findings.push({
      direction: result.direction,
      kind: 'focus-trap',
      detail: result.detail ?? 'trap',
    })
  }
  if (result.end === 'limit') {
    findings.push({
      direction: result.direction,
      kind: 'walk-incomplete',
      detail: result.detail ?? 'limit',
    })
  }
  return findings
}

/** Capture the exact spacing-stress review cases after the keyboard walk. */
async function captureSpacingReview(page: Page, route: RouteSpec, ctx: WalkContext): Promise<void> {
  const feed = route.id === 'admin-feed' || route.id === 'anonymous-feed'
  // A board button's text includes its screen-reader phrase ("127 posts"), so
  // the board is matched by the start of its name.
  const targets = feed
    ? [
        { selector: '#portal-main aside nav button', text: /^Feature Requests\s/ },
        { selector: '#portal-main aside nav button', text: /^General Feedback\s/ },
      ]
    : route.id === 'admin-post'
      ? [
          {
            // The status selector belongs to the top-level composer; replies share the form test id.
            selector: 'form[data-testid="comment-form"]:has([id^="comment-status-label-"]) button',
            text: /^Internal note \(team only\)$/,
          },
        ]
      : route.id === 'admin-settings-statuses'
        ? [{ selector: 'p', text: /^Toggle statuses to show on your roadmap$/ }]
        : route.id === 'member-admin-only-notice'
          ? [
              { selector: '#admin-only-notice-title', text: /^Administrators only$/ },
              {
                selector: '[data-testid="admin-only-notice"] p',
                text: /^Only administrators can change workspace settings such as members, sign-in, portal access, branding, boards and integrations\.$/,
              },
            ]
          : []
  // Once per route: in the reduced-motion walk of the viewport named here.
  if (targets.length === 0) return
  if (ctx.viewport !== (feed ? 'desktop-fine' : 'phone-coarse') || ctx.motion !== 'reduce') return

  // Only these previously reported widths are captured. This adds no test,
  // browser context, checker modification or acceptance waiver. The checker
  // runs after this walk, so a region's disposition says only whether a
  // resolution is on record for its route, text and width; summarize.ts
  // compares each region with the checker's review items and says whether the
  // checker flagged it on this run.
  const widths = feed ? [1024, 1440, 1920, 2560] : [320]
  const directory = REVIEW_DIR
  fs.mkdirSync(directory, { recursive: true })
  await page.addStyleTag({
    content: `
      * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
      p { margin-bottom: 2em !important; }
    `,
  })
  for (const width of widths) {
    await page.setViewportSize({ width, height: ctx.height })
    await page.evaluate(async () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      window.scrollTo(0, 0)
      await document.fonts.ready
    })
    for (const target of targets) {
      const element = page.locator(target.selector).filter({ hasText: target.text })
      await expect(element).toHaveCount(1)
      await element.scrollIntoViewIfNeeded()
    }
    const regions = []
    for (const target of targets) {
      const element = page.locator(target.selector).filter({ hasText: target.text })
      await expect(element).toHaveCount(1)
      await expect(element).toBeVisible()
      const measurement = await element.evaluate((node) => {
        const style = getComputedStyle(node)
        const box = node.getBoundingClientRect()
        const size = parseFloat(style.fontSize)
        // The text as the checker reads it: screen-reader-only text excluded.
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        let checkerText = ''
        while (walker.nextNode()) {
          const parent = walker.currentNode.parentElement
          if (!parent?.closest('.sr-only,.ds-sr-only')) checkerText += walker.currentNode.textContent
        }
        return {
          text: node.textContent,
          checkerText: checkerText.replace(/\s+/g, ' ').trim(),
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          // The screenshot below is the full page; box is in viewport
          // coordinates, so pageBox places the region on the screenshot.
          pageBox: {
            x: box.x + window.scrollX,
            y: box.y + window.scrollY,
            width: box.width,
            height: box.height,
          },
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          spacing: {
            line: parseFloat(style.lineHeight) / size,
            letter: parseFloat(style.letterSpacing) / size,
            word: parseFloat(style.wordSpacing) / size,
          },
        }
      })
      const resolution = resolutionFor(route.id, measurement.checkerText, `${width}s`)
      regions.push({
        selector: target.selector,
        expectedText: target.text.source,
        ...measurement,
        disposition: resolution
          ? `RESOLVED: ${resolution.resolution}`
          : 'REVIEW_REQUIRED: inspect the region and record its specific resolution in e2e/render/review-resolutions.ts.',
      })
    }
    const evidence = {
      schema: 'venturi.portal-spacing-review.v2',
      source: process.env.GITHUB_SHA ?? null,
      route: route.id,
      identity: route.identity,
      url: page.url(),
      viewport: page.viewportSize(),
      locale: 'en-US',
      textSpacingStress: true,
      capturedAt: new Date().toISOString(),
      regions,
      disposition: regions.every((region) => region.disposition.startsWith('RESOLVED'))
        ? 'RESOLVED: every region has a recorded resolution (regions[].disposition).'
        : 'REVIEW_REQUIRED: inspect each region without a resolution and record its specific resolution in e2e/render/review-resolutions.ts.',
      pngBase64: (await page.screenshot({ fullPage: true, animations: 'disabled' })).toString(
        'base64'
      ),
    }
    fs.writeFileSync(
      path.join(directory, `${route.id}__${width}__spacing.json`),
      `${JSON.stringify(evidence, null, 2)}\n`
    )
  }
}

test.describe.configure({ mode: 'parallel' })

/**
 * How the Shift+Tab walk compares with the Tab walk, by element identity
 * rather than by selector. The two can differ for a sound reason: a list that
 * loads another page while the walk passes it has more stops on the way back.
 * The comparison is evidence for review, not a finding: an element reached in
 * only one direction is named here so a reviewer can tell which case it is.
 */
function compareWalks(forward: WalkResult, reverse: WalkResult) {
  const back = [...reverse.stops].reverse()
  const forwardKeys = new Set(forward.stops.map((s) => s.key))
  const reverseKeys = new Set(back.map((s) => s.key))
  const brief = (s: StopResult) => ({ selector: s.selector, name: s.name })
  return {
    matchesForward:
      back.length === forward.stops.length && back.every((s, i) => s.key === forward.stops[i].key),
    forwardOnly: forward.stops.filter((s) => !reverseKeys.has(s.key)).map(brief),
    reverseOnly: back.filter((s) => !forwardKeys.has(s.key)).map(brief),
  }
}

for (const route of ROUTES) {
  for (const ctx of walkContextsFor(route)) {
    test(`${route.id} at ${ctx.id}`, async ({ browser }) => {
      test.setTimeout(240_000)
      const plan = readPlan()
      const planned: RouteSpec | undefined = plan.routes.find((r) => r.id === route.id)
      if (!planned) throw new Error(`The render plan has no route ${route.id}`)
      const storageState = plan.storageStates[planned.identity] ?? undefined
      const context = await browser.newContext({
        baseURL: plan.baseURL,
        viewport: { width: ctx.width, height: ctx.height },
        hasTouch: ctx.hasTouch,
        storageState,
        locale: 'en-US',
        reducedMotion: ctx.motion,
      })
      const findings: Finding[] = []
      const page = await context.newPage()
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      let forward: WalkResult | null = null
      let reverse: WalkResult | null = null
      let pointerCoarse: boolean | null = null
      let initialFocus: string | null = null
      let positive: string[] = []
      let httpStatus: number | null = null
      try {
        const response = await page.goto(planned.path, { waitUntil: 'load' })
        httpStatus = response?.status() ?? null
        if (!httpStatus || httpStatus >= 400) {
          findings.push({
            kind: 'http-status',
            detail: `document response ${httpStatus ?? 'unavailable'}`,
          })
        }
        // Server-rendered controls exist before their handlers hydrate.
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
        await page.evaluate(() => document.fonts.ready.then(() => undefined))

        const expectedEmail = plan.emails[planned.identity]
        const sessionResponse = await context.request.get('/api/auth/get-session')
        const session = sessionResponse.ok()
          ? ((await sessionResponse.json().catch(() => null)) as {
              user?: { email?: string }
            } | null)
          : null
        const actualEmail = session?.user?.email ?? null
        if (actualEmail !== expectedEmail) {
          findings.push({
            kind: 'identity',
            detail: `session belongs to ${actualEmail ?? 'nobody'}, expected ${expectedEmail ?? 'nobody'}`,
          })
        }

        for (const surface of planned.surfaces) {
          if (!(await probeSurface(page, surface, ctx.width))) {
            findings.push({
              kind: 'surface-missing',
              detail: `${surface.label} is not on the page`,
            })
          }
        }

        await page.evaluate(installWalker, { minTarget: ctx.minTarget, pointer: ctx.pointer })
        pointerCoarse = await page.evaluate(() => window.__renderWalk!.pointerCoarse())
        if (pointerCoarse !== (ctx.pointer === 'coarse')) {
          findings.push({
            kind: 'pointer-emulation',
            detail: `(pointer: coarse) is ${pointerCoarse} in the ${ctx.id} context`,
          })
        }
        initialFocus = await page.evaluate(() => window.__renderWalk!.initialFocus())
        positive = await page.evaluate(() => window.__renderWalk!.positiveTabindex())
        for (const selector of positive) {
          findings.push({
            kind: 'positive-tabindex',
            selector,
            detail: 'tabindex above 0 overrides document order',
          })
        }

        forward = await walk(page, 'forward', `${planned.id}__${ctx.id}`)
        findings.push(...stopFindings(forward, ctx))
        reverse = await walk(page, 'reverse', `${planned.id}__${ctx.id}`)
        findings.push(...stopFindings(reverse, ctx))
        await captureSpacingReview(page, planned, ctx)
      } finally {
        for (const message of pageErrors) findings.push({ kind: 'page-error', detail: message })
        const result = {
          route: planned.id,
          identity: planned.identity,
          path: planned.path,
          context: ctx,
          httpStatus,
          finalURL: page.url(),
          pointerCoarse,
          initialFocus,
          positiveTabindex: positive,
          forward: forward && {
            end: forward.end,
            detail: forward.detail ?? null,
            stops: forward.stops,
          },
          reverse: reverse && {
            end: reverse.end,
            detail: reverse.detail ?? null,
            stopCount: reverse.stops.length,
            ...(forward
              ? compareWalks(forward, reverse)
              : { matchesForward: false, forwardOnly: [], reverseOnly: [] }),
            stops: reverse.stops,
          },
          findings,
        }
        fs.mkdirSync(KEYBOARD_DIR, { recursive: true })
        fs.writeFileSync(
          path.join(KEYBOARD_DIR, `${planned.id}__${ctx.id}.json`),
          `${JSON.stringify(result, null, 2)}\n`
        )
        await context.close()
      }
      expect(
        findings,
        findings.map((f) => `${f.kind}: ${f.selector ?? ''} ${f.detail}`).join('\n')
      ).toEqual([])
    })
  }
}
