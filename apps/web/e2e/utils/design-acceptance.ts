import type { Page } from '@playwright/test'

/**
 * Review artifact only: NOT_RUN. No browser is created and no DOM is mutated.
 * Bound to corpus 6.6 typography-quality and quality-policy at 14bfa3b48761.
 * These measurements are evidence, not a substitute for rendered-font identity,
 * route/state coverage, human-readable review dispositions, or real browser zoom.
 */
export interface TypographyRegion {
  selector: string
  profile: 'headline' | 'short-copy' | 'prose'
  origin: 'authored' | 'user' | 'localized'
  locale: string
  immutable?: boolean
  /** Hidden responsive counterparts are recorded; at least one visible match is required by default. */
  visibility?: 'required-visible' | 'allow-hidden'
}

export interface ReflowScope {
  selector: string
  visibility?: 'required-visible' | 'allow-hidden'
  expectInteractive?: boolean
}

export interface MeasurementContext {
  artifactRevision: string
  state: string
  /** Record actual zoom separately; this string labels a fixture, never proves browser zoom. */
  stress?: string
}

type Segment = { segment: string; index: number; isWordLike?: boolean }
type SegmenterConstructor = {
  new (
    locale: string,
    options: { granularity: 'grapheme' | 'word' }
  ): {
    segment(value: string): Iterable<Segment>
    resolvedOptions(): { locale: string }
  }
  supportedLocalesOf(locales: string[]): string[]
}

export async function measureTypography(
  page: Page,
  regions: TypographyRegion[],
  context: MeasurementContext,
  options: { fontWaitMs?: number } = {}
) {
  if (
    options.fontWaitMs !== undefined &&
    (!Number.isFinite(options.fontWaitMs) || options.fontWaitMs <= 0)
  )
    throw new RangeError('fontWaitMs must be a finite positive number')
  return page.evaluate(
    async ({ regions, context, fontWaitMs }) => {
      type Rect = {
        x: number
        y: number
        width: number
        height: number
        left: number
        right: number
        top: number
        bottom: number
      }
      type Fragment = { start: number; end: number; text: string; nodePath: string; rect: Rect }
      type Line = { top: number; bottom: number; fragments: Fragment[] }
      type Status = 'pass' | 'fail' | 'review-required' | 'exempt' | 'not-applicable'
      const rect = (r: DOMRect): Rect => ({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      })
      const domPath = (element: Element): string => {
        const parts: string[] = []
        let current: Element | null = element
        while (current) {
          const parent: Element | null = current.parentElement
          const ordinal = parent ? Array.from(parent.children).indexOf(current) + 1 : 1
          parts.unshift(`${current.localName}:nth-child(${ordinal})`)
          current = parent
        }
        return parts.join(' > ')
      }
      const hiddenReason = (element: Element): string | null => {
        if (getComputedStyle(element).visibility !== 'visible') return 'visibility-hidden'
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node)
          if (style.display === 'none') return 'display-none'
          if (style.contentVisibility === 'hidden') return 'content-visibility-hidden'
          if (Number(style.opacity) === 0) return 'opacity-zero'
          const box = node.getBoundingClientRect()
          if (
            box.width <= 1 &&
            box.height <= 1 &&
            style.position === 'absolute' &&
            (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)')
          )
            return 'visually-hidden-text'
        }
        return null
      }
      let timeout: ReturnType<typeof setTimeout> | undefined
      const fontReadiness = await Promise.race([
        document.fonts.ready.then(() => 'ready' as const),
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), fontWaitMs)
        }),
      ])
      if (timeout !== undefined) clearTimeout(timeout)
      const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter
      const environment = {
        ...context,
        routeOrPage: location.href,
        observedAt: new Date().toISOString(),
        viewportOrCanvas: {
          width: innerWidth,
          height: innerHeight,
          documentWidth: document.documentElement.clientWidth,
          devicePixelRatio,
          visualViewportScale: visualViewport?.scale ?? null,
        },
        browserZoom: 'not-measured',
        fontReadiness,
        fontSetStatus: document.fonts.status,
        fontIdentity: {
          status: 'not-measured',
          explanation:
            'FontFaceSet readiness/check and computed font-family do not identify the fonts that rendered actual glyphs. Attach independent platform-font evidence for the matched DOM node.',
        },
      }
      const findings: Array<{
        region: TypographyRegion
        matchIndex: number | null
        elementOrRegion: string
        selectedText: string
        renderedText: string
        bounds: Rect | null
        font: {
          computedFamily: string
          size: string
          weight: string
          style: string
          availabilityCheck: boolean | null
        } | null
        direction: string | null
        writingMode: string | null
        segmentation: {
          requestedLocale: string
          resolvedLocale: string | null
          supported: boolean | null
        }
        excluded: Array<{ text: string; reason: string; nodePath: string }>
        lines: Array<{
          index: number
          top: number
          bottom: number
          left: number
          right: number
          span: number
          text: string
          wordCount: number | null
          fragments: Fragment[]
        }>
        finalLineRatio: number | null
        isolatedFinalWord: boolean | null
        linePolicyStatus: Status
        acceptanceStatus: 'fail' | 'review-required' | 'not-applicable'
        reasons: string[]
      }> = []
      const coverage: Array<{
        selector: string
        matches: number
        visibleMatches: number
        hiddenMatches: number
        status: 'measured' | 'incomplete' | 'not-applicable'
      }> = []
      for (const region of regions) {
        let matches: Element[] = []
        let selectorError: string | null = null
        try {
          matches = Array.from(document.querySelectorAll(region.selector))
        } catch (error) {
          selectorError = String(error)
        }
        let visibleMatches = 0
        for (const [matchIndex, element] of matches.entries()) {
          const style = getComputedStyle(element)
          const selectedText = element.textContent ?? ''
          const reasonHidden = hiddenReason(element)
          const base = {
            region,
            matchIndex,
            elementOrRegion: domPath(element),
            selectedText,
            bounds: rect(element.getBoundingClientRect()),
            direction: style.direction,
            writingMode: style.writingMode,
            segmentation: {
              requestedLocale: region.locale,
              resolvedLocale: null as string | null,
              supported: null as boolean | null,
            },
            font: {
              computedFamily: style.fontFamily,
              size: style.fontSize,
              weight: style.fontWeight,
              style: style.fontStyle,
              availabilityCheck: null as boolean | null,
            },
          }
          if (reasonHidden) {
            findings.push({
              ...base,
              renderedText: '',
              excluded: [{ text: selectedText, reason: reasonHidden, nodePath: domPath(element) }],
              lines: [],
              finalLineRatio: null,
              isolatedFinalWord: null,
              linePolicyStatus: 'not-applicable',
              acceptanceStatus: 'not-applicable',
              reasons: [
                'Nonrendered match recorded; responsive counterpart is not a product failure.',
              ],
            })
            continue
          }
          visibleMatches += 1
          const reasons: string[] = []
          if (fontReadiness !== 'ready' || document.fonts.status !== 'loaded')
            reasons.push('font-loading-not-settled')
          if (region.origin !== 'authored')
            reasons.push(`text-origin-${region.origin}-requires-specific-review`)
          if (region.immutable) reasons.push('immutable-text-requires-specific-review')
          if (style.writingMode !== 'horizontal-tb') reasons.push('unsupported-writing-mode')
          if (style.columnCount !== 'auto' && style.columnCount !== '1')
            reasons.push('unsupported-multicolumn-layout')
          if (element.shadowRoot) reasons.push('shadow-root-text-not-inspected')
          if (element.matches('canvas, iframe, object, embed'))
            reasons.push('embedded-text-surface-not-measured')
          let graphemeSegmenter: InstanceType<SegmenterConstructor> | null = null
          let wordSegmenter: InstanceType<SegmenterConstructor> | null = null
          try {
            if (!Segmenter) throw new Error('Intl.Segmenter unavailable')
            base.segmentation.supported = Segmenter.supportedLocalesOf([region.locale]).length > 0
            if (!base.segmentation.supported)
              reasons.push('requested-segmentation-locale-unsupported')
            graphemeSegmenter = new Segmenter(region.locale, { granularity: 'grapheme' })
            wordSegmenter = new Segmenter(region.locale, { granularity: 'word' })
            base.segmentation.resolvedLocale = wordSegmenter.resolvedOptions().locale
          } catch (error) {
            reasons.push(`locale-segmentation-unsupported: ${String(error)}`)
          }
          try {
            const primaryFamily = style.fontFamily
              .split(',')[0]
              .trim()
              .replace(/^['"]|['"]$/g, '')
            base.font.availabilityCheck =
              document.fonts.check(
                `${style.fontStyle} ${style.fontWeight} ${style.fontSize} "${primaryFamily}"`,
                selectedText
              ) ||
              document.fonts.check(
                `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
                selectedText
              )
          } catch {
            reasons.push('font-availability-check-unsupported')
          }
          if (base.font.availabilityCheck === false) reasons.push('declared-font-not-available')
          const excluded: Array<{ text: string; reason: string; nodePath: string }> = []
          const fragments: Fragment[] = []
          const checkedElements = new Set<Element>()
          const blocks = new Set<Element>()
          let renderedText = ''
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
          )
          while (walker.nextNode()) {
            if (walker.currentNode.nodeType === Node.ELEMENT_NODE) {
              const child = walker.currentNode as Element
              if (!hiddenReason(child) && child.shadowRoot)
                reasons.push('shadow-root-text-not-inspected')
              if (!hiddenReason(child) && child.matches('canvas, iframe, object, embed'))
                reasons.push('embedded-text-surface-not-measured')
              if (child.localName === 'br' && !hiddenReason(child)) renderedText += '\n'
              continue
            }
            const node = walker.currentNode as Text
            const parent = node.parentElement
            if (!parent || !node.data) continue
            const path = domPath(parent)
            const excludedAncestor = parent.closest(
              'script, style, noscript, template, [data-design-decorative="true"], svg[aria-hidden="true"], svg[role="presentation"], [data-icon][aria-hidden="true"]'
            )
            const hidden = hiddenReason(parent)
            if (excludedAncestor || hidden) {
              excluded.push({
                text: node.data,
                reason: hidden ?? `non-text-or-explicit-decoration:${excludedAncestor?.localName}`,
                nodePath: path,
              })
              continue
            }
            for (
              let current: Element | null = parent;
              current && element.contains(current);
              current = current.parentElement
            ) {
              if (checkedElements.has(current)) continue
              checkedElements.add(current)
              const computed = getComputedStyle(current)
              if (current !== element && !['inline', 'contents'].includes(computed.display))
                blocks.add(current)
              if (computed.writingMode !== 'horizontal-tb')
                reasons.push('unsupported-descendant-writing-mode')
              if (
                computed.transform !== 'none' ||
                ['scale', 'rotate', 'translate', 'perspective'].some(
                  (property) => !['', 'none'].includes(computed.getPropertyValue(property))
                )
              )
                reasons.push('transformed-text-needs-render-review')
              if (computed.hyphens === 'auto')
                reasons.push('automatic-hyphenation-needs-render-review')
              if (computed.unicodeBidi.includes('override'))
                reasons.push('bidi-override-needs-render-review')
              if (
                computed.clipPath !== 'none' ||
                computed.maskImage !== 'none' ||
                (computed.clip && computed.clip !== 'auto')
              )
                reasons.push('clipped-or-masked-text-needs-render-review')
              if (Number.parseFloat(computed.lineHeight) < Number.parseFloat(computed.fontSize))
                reasons.push('overlapping-line-boxes-need-render-review')
              const zoom = computed.getPropertyValue('zoom')
              if (zoom && !['1', 'normal'].includes(zoom))
                reasons.push('css-zoomed-text-needs-render-review')
              if (current !== element && computed.verticalAlign !== 'baseline')
                reasons.push('nonbaseline-inline-text-needs-review')
              if (computed.textOverflow === 'ellipsis' || computed.webkitLineClamp !== 'none') {
                if (
                  computed.textOverflow === 'ellipsis' ||
                  (computed.webkitLineClamp &&
                    computed.webkitLineClamp !== 'none' &&
                    computed.webkitLineClamp !== '0')
                )
                  reasons.push('potential-text-truncation-needs-review')
              }
              for (const pseudo of ['::before', '::after']) {
                const content = getComputedStyle(current, pseudo).content
                if (content && !['none', 'normal', '""', "''"].includes(content))
                  reasons.push(`generated-text-not-measured:${domPath(current)}${pseudo}`)
              }
            }
            if (parent.closest('[aria-hidden="true"]'))
              reasons.push('visible-aria-hidden-text-retained-for-review')
            if (parent.closest('svg, math, ruby'))
              reasons.push('unsupported-specialized-inline-content')
            for (
              let ancestor: Element | null = element.parentElement;
              ancestor;
              ancestor = ancestor.parentElement
            ) {
              const computed = getComputedStyle(ancestor)
              if (
                computed.transform !== 'none' ||
                ['scale', 'rotate', 'translate', 'perspective'].some(
                  (property) => !['', 'none'].includes(computed.getPropertyValue(property))
                )
              )
                reasons.push('transformed-text-ancestor-needs-render-review')
              if (
                computed.clipPath !== 'none' ||
                computed.maskImage !== 'none' ||
                (computed.clip && computed.clip !== 'auto')
              )
                reasons.push('clipped-or-masked-text-ancestor-needs-render-review')
              const zoom = computed.getPropertyValue('zoom')
              if (zoom && !['1', 'normal'].includes(zoom))
                reasons.push('css-zoomed-text-ancestor-needs-render-review')
            }
            const clips: Array<{
              left: number
              right: number
              top: number
              bottom: number
              x: boolean
              y: boolean
            }> = []
            for (
              let ancestor: Element | null = parent;
              ancestor;
              ancestor = ancestor.parentElement
            ) {
              const computed = getComputedStyle(ancestor)
              const x = ['hidden', 'clip'].includes(computed.overflowX)
              const y = ['hidden', 'clip'].includes(computed.overflowY)
              if (x || y) {
                const box = ancestor.getBoundingClientRect()
                const left = box.left + ancestor.clientLeft
                const top = box.top + ancestor.clientTop
                clips.push({
                  left,
                  right: left + ancestor.clientWidth,
                  top,
                  bottom: top + ancestor.clientHeight,
                  x,
                  y,
                })
              }
            }
            const start = renderedText.length
            renderedText += node.data
            // Keep all text, even when locale segmentation cannot be performed.
            let fallbackIndex = 0
            const segments = graphemeSegmenter
              ? Array.from(graphemeSegmenter.segment(node.data))
              : Array.from(node.data).map((segment) => {
                  const index = fallbackIndex
                  fallbackIndex += segment.length
                  return { segment, index }
                })
            for (const segment of segments) {
              if (/^\s+$/u.test(segment.segment)) continue // Whitespace stays in text/word evidence, not in line-span extrema.
              const range = document.createRange()
              range.setStart(node, segment.index)
              range.setEnd(node, segment.index + segment.segment.length)
              const boxes = Array.from(range.getClientRects()).filter(
                (box) => box.width > 0 && box.height > 0
              )
              if (
                boxes.length === 0 &&
                Array.from(segment.segment).some(
                  (character) => !'\u200b\u200c\u200d\u2060\ufeff'.includes(character)
                )
              )
                reasons.push('non-whitespace-text-has-no-rendered-fragment')
              for (const box of boxes) {
                if (
                  clips.some(
                    (clip) =>
                      (clip.x && (box.left < clip.left - 1 || box.right > clip.right + 1)) ||
                      (clip.y && (box.top < clip.top - 1 || box.bottom > clip.bottom + 1))
                  )
                )
                  reasons.push('text-range-extends-beyond-clipping-ancestor')
                fragments.push({
                  start: start + segment.index,
                  end: start + segment.index + segment.segment.length,
                  text: segment.segment,
                  nodePath: path,
                  rect: rect(box),
                })
              }
            }
          }
          if (blocks.size > 0)
            reasons.push(
              'selected-region-contains-independent-blocks-select-individual-text-blocks'
            )
          const lines: Line[] = []
          for (const fragment of [...fragments].sort(
            (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left
          )) {
            const candidates = lines.filter((line) => {
              const overlap =
                Math.min(line.bottom, fragment.rect.bottom) - Math.max(line.top, fragment.rect.top)
              return overlap > Math.min(line.bottom - line.top, fragment.rect.height) * 0.5
            })
            if (candidates.length > 1) reasons.push('ambiguous-overlapping-line-fragments')
            const line = candidates[0]
            if (line) {
              line.fragments.push(fragment)
              line.top = Math.min(line.top, fragment.rect.top)
              line.bottom = Math.max(line.bottom, fragment.rect.bottom)
            } else
              lines.push({
                top: fragment.rect.top,
                bottom: fragment.rect.bottom,
                fragments: [fragment],
              })
          }
          lines.sort((a, b) => a.top - b.top)
          const words = wordSegmenter
            ? Array.from(wordSegmenter.segment(renderedText)).filter((word) => word.isWordLike)
            : null
          const wordIds = lines.map((line) =>
            words
              ? words.flatMap((word, index) =>
                  line.fragments.some(
                    (f) => f.start < word.index + word.segment.length && f.end > word.index
                  )
                    ? [index]
                    : []
                )
              : []
          )
          const measuredLines = lines.map((line, index) => {
            const left = Math.min(...line.fragments.map((fragment) => fragment.rect.left))
            const right = Math.max(...line.fragments.map((fragment) => fragment.rect.right))
            const logical = [...line.fragments].sort((a, b) => a.start - b.start)
            const first = logical[0]
            const last = logical.at(-1)
            return {
              index,
              top: line.top,
              bottom: line.bottom,
              left,
              right,
              span: right - left,
              text: first && last ? renderedText.slice(first.start, last.end).trim() : '',
              wordCount: words ? wordIds[index].length : null,
              fragments: line.fragments,
            }
          })
          const final = measuredLines.at(-1)
          const preceding = measuredLines.slice(0, -1)
          const finalLineRatio =
            final && preceding.length
              ? final.span / Math.max(...preceding.map((line) => line.span))
              : null
          const finalWordIds = wordIds.at(-1) ?? []
          const wordIsSplit =
            finalWordIds.length === 1 &&
            wordIds.slice(0, -1).some((ids) => ids.includes(finalWordIds[0]))
          const isolatedFinalWord = words ? finalWordIds.length === 1 && !wordIsSplit : null
          if (measuredLines.length > 1 && finalWordIds.length === 0)
            reasons.push('final-line-has-no-segmented-word')
          if (wordIsSplit) reasons.push('word-spans-final-line-boundary')
          if (!fragments.length) reasons.push('no-measurable-rendered-text')
          const threshold =
            region.profile === 'headline' ? 0.6 : region.profile === 'short-copy' ? 0.45 : 0.25
          const belowThreshold = finalLineRatio !== null && finalLineRatio < threshold
          let linePolicyStatus: Status = 'pass'
          if (measuredLines.length === 1) linePolicyStatus = 'exempt'
          if (reasons.length) linePolicyStatus = 'review-required'
          if (measuredLines.length > 1 && (belowThreshold || isolatedFinalWord)) {
            if (belowThreshold) reasons.push(`final-line-ratio-below-${threshold}`)
            if (isolatedFinalWord) reasons.push('isolated-final-word')
            // A user/immutable/localized string must never be rewritten to satisfy a cosmetic profile.
            linePolicyStatus =
              region.profile !== 'prose' &&
              region.origin === 'authored' &&
              !region.immutable &&
              reasons.every(
                (reason) =>
                  reason.startsWith('final-line-ratio-') || reason === 'isolated-final-word'
              )
                ? 'fail'
                : 'review-required'
          }
          findings.push({
            ...base,
            renderedText,
            excluded,
            lines: measuredLines,
            finalLineRatio,
            isolatedFinalWord,
            linePolicyStatus,
            acceptanceStatus: linePolicyStatus === 'fail' ? 'fail' : 'review-required',
            reasons: [...new Set(reasons), 'rendered-glyph-identity-evidence-required'],
          })
        }
        const required = region.visibility !== 'allow-hidden'
        const incomplete = Boolean(selectorError) || (required && visibleMatches === 0)
        coverage.push({
          selector: region.selector,
          matches: matches.length,
          visibleMatches,
          hiddenMatches: matches.length - visibleMatches,
          status: incomplete ? 'incomplete' : visibleMatches ? 'measured' : 'not-applicable',
        })
        if (incomplete)
          findings.push({
            region,
            matchIndex: null,
            elementOrRegion: region.selector,
            selectedText: '',
            renderedText: '',
            bounds: null,
            font: null,
            direction: null,
            writingMode: null,
            segmentation: { requestedLocale: region.locale, resolvedLocale: null, supported: null },
            excluded: [],
            lines: [],
            finalLineRatio: null,
            isolatedFinalWord: null,
            linePolicyStatus: 'review-required',
            acceptanceStatus: 'review-required',
            reasons: [
              selectorError
                ? `invalid-selector:${selectorError}`
                : 'required-region-has-zero-visible-matches',
            ],
          })
      }
      return {
        schema: 'venturi.design-typography-evidence.v1',
        environment,
        coverage,
        findings,
        acceptanceStatus: findings.some((finding) => finding.acceptanceStatus === 'fail')
          ? ('fail' as const)
          : ('review-required' as const),
        limitations: [
          'Actual rendered glyph identities require separate evidence tied to each matched selector/index or DOM path.',
          'Line grouping uses Range fragments; ambiguous layout is reported for review.',
          'Selected text is preserved; this helper does not inventory elements outside the explicit selectors or closed shadow roots.',
          'Accessible reflow, locale, user content and immutable constraints require a specific recorded disposition, never a blanket waiver.',
        ],
      }
    },
    { regions, context, fontWaitMs: options.fontWaitMs ?? 5000 }
  )
}

export async function measureReflow(
  page: Page,
  scopes: ReflowScope[],
  context: MeasurementContext,
  options: { minimumTarget?: number; tolerance?: number } = {}
) {
  if (
    options.minimumTarget !== undefined &&
    (!Number.isFinite(options.minimumTarget) || options.minimumTarget <= 0)
  )
    throw new RangeError('minimumTarget must be a finite positive number')
  if (
    options.tolerance !== undefined &&
    (!Number.isFinite(options.tolerance) || options.tolerance < 0)
  )
    throw new RangeError('tolerance must be a finite non-negative number')
  return page.evaluate(
    ({ scopes, context, minimumTarget, tolerance }) => {
      const rect = (r: DOMRect) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      })
      const hiddenReason = (element: Element): string | null => {
        if (getComputedStyle(element).visibility !== 'visible') return 'visibility-hidden'
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node)
          if (style.display === 'none') return 'display-none'
          if (style.contentVisibility === 'hidden') return 'content-visibility-hidden'
          if (Number(style.opacity) === 0) return 'opacity-zero'
          const box = node.getBoundingClientRect()
          if (
            box.width <= 1 &&
            box.height <= 1 &&
            style.position === 'absolute' &&
            (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)')
          )
            return 'visually-hidden'
        }
        return null
      }
      const interactiveSelector =
        'a[href],button,input:not([type="hidden"]),select,textarea,[contenteditable="true"],[role="button"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[role="radio"],[role="combobox"],[tabindex]'
      const issues: Array<{
        kind: string
        severity: 'fail' | 'review-required'
        scope: string
        element: string
        evidence: unknown
      }> = []
      const inspectedCoordinates = new Set<Element>()
      const inspectCoordinates = (element: Element, scope: string, reference: string) => {
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          if (inspectedCoordinates.has(ancestor)) continue
          inspectedCoordinates.add(ancestor)
          const computed = getComputedStyle(ancestor)
          const zoom = computed.getPropertyValue('zoom')
          const individualTransforms = Object.fromEntries(
            ['scale', 'rotate', 'translate', 'perspective'].map((property) => [
              property,
              computed.getPropertyValue(property),
            ])
          )
          if (
            computed.transform !== 'none' ||
            Object.values(individualTransforms).some((value) => !['', 'none'].includes(value)) ||
            (zoom && !['1', 'normal'].includes(zoom))
          )
            issues.push({
              kind: 'transformed-coordinate-frame-needs-review',
              severity: 'review-required',
              scope,
              element: reference,
              evidence: {
                ancestor: ancestor.localName,
                transform: computed.transform,
                individualTransforms,
                zoom,
              },
            })
          if (
            computed.clipPath !== 'none' ||
            computed.maskImage !== 'none' ||
            (computed.clip && computed.clip !== 'auto')
          )
            issues.push({
              kind: 'clipped-or-masked-coordinate-frame-needs-review',
              severity: 'review-required',
              scope,
              element: reference,
              evidence: {
                ancestor: ancestor.localName,
                clipPath: computed.clipPath,
                maskImage: computed.maskImage,
                clip: computed.clip,
              },
            })
        }
      }
      const records: Array<{
        selector: string
        matchIndex: number
        hidden: string | null
        bounds: ReturnType<typeof rect>
        overflow: { width: number; clientWidth: number; mode: string }
        controls: Array<{
          index: number
          tag: string
          role: string | null
          label: string
          disabled: boolean
          hidden: string | null
          bounds: ReturnType<typeof rect>
          scrollContained: boolean
        }>
      }> = []
      const coverage: Array<{
        selector: string
        matches: number
        visibleMatches: number
        interactiveMatches: number
      }> = []
      if (scopes.length === 0)
        issues.push({
          kind: 'no-scopes-declared',
          severity: 'review-required',
          scope: 'document',
          element: 'html',
          evidence: {},
        })
      const documentOverflow =
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      if (documentOverflow > tolerance)
        issues.push({
          kind: 'horizontal-page-overflow',
          severity: 'fail',
          scope: 'document',
          element: 'html',
          evidence: {
            overflow: documentOverflow,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          },
        })
      if (document.body) {
        const rootStyle = getComputedStyle(document.documentElement)
        const bodyStyle = getComputedStyle(document.body)
        for (const axis of ['overflowX', 'overflowY'] as const) {
          if (rootStyle[axis] === 'visible' && ['hidden', 'clip'].includes(bodyStyle[axis]))
            issues.push({
              kind: 'body-overflow-propagation-needs-viewport-reachability-review',
              severity: 'review-required',
              scope: 'document',
              element: 'body',
              evidence: { axis, rootOverflow: rootStyle[axis], bodyOverflow: bodyStyle[axis] },
            })
        }
      }
      for (const scope of scopes) {
        let matches: Element[]
        try {
          matches = Array.from(document.querySelectorAll(scope.selector))
        } catch (error) {
          issues.push({
            kind: 'invalid-selector',
            severity: 'review-required',
            scope: scope.selector,
            element: scope.selector,
            evidence: String(error),
          })
          continue
        }
        let visibleMatches = 0
        let interactiveMatches = 0
        for (const [matchIndex, element] of matches.entries()) {
          const style = getComputedStyle(element)
          const hidden = hiddenReason(element)
          const record: (typeof records)[number] = {
            selector: scope.selector,
            matchIndex,
            hidden,
            bounds: rect(element.getBoundingClientRect()),
            overflow: {
              width: element.scrollWidth,
              clientWidth: element.clientWidth,
              mode: style.overflowX,
            },
            controls: [],
          }
          records.push(record)
          if (hidden) continue
          visibleMatches += 1
          inspectCoordinates(element, scope.selector, `${scope.selector}[${matchIndex}]`)
          if (record.bounds.width <= 0 || record.bounds.height <= 0)
            issues.push({
              kind:
                style.display === 'contents'
                  ? 'display-contents-scope-needs-child-geometry'
                  : 'scope-has-no-measurable-box',
              severity: 'review-required',
              scope: scope.selector,
              element: `${scope.selector}[${matchIndex}]`,
              evidence: { bounds: record.bounds, required: scope.visibility !== 'allow-hidden' },
            })
          for (const host of [element, ...element.querySelectorAll('*')]) {
            if (hiddenReason(host)) continue
            if (
              host.shadowRoot ||
              host.matches('iframe, object, embed, video[controls], audio[controls]')
            )
              issues.push({
                kind: host.shadowRoot
                  ? 'shadow-root-controls-not-inspected'
                  : 'embedded-controls-not-inspected',
                severity: 'review-required',
                scope: scope.selector,
                element: host.localName,
                evidence: { bounds: rect(host.getBoundingClientRect()) },
              })
          }
          if (
            element.scrollWidth - element.clientWidth > tolerance &&
            !['auto', 'scroll'].includes(style.overflowX)
          )
            issues.push({
              kind: ['hidden', 'clip'].includes(style.overflowX)
                ? 'scope-content-clipped'
                : 'scope-content-overflow',
              severity: 'review-required',
              scope: scope.selector,
              element: `${scope.selector}[${matchIndex}]`,
              evidence: record.overflow,
            })
          const controls = [
            ...(element.matches(interactiveSelector) ? [element] : []),
            ...element.querySelectorAll(interactiveSelector),
          ].filter(
            (control) =>
              !(
                control.hasAttribute('tabindex') &&
                control.getAttribute('tabindex') === '-1' &&
                !control.matches(interactiveSelector.replace(',[tabindex]', ''))
              )
          )
          for (const [index, control] of controls.entries()) {
            const controlHidden = hiddenReason(control)
            const bounds = rect(control.getBoundingClientRect())
            const disabled =
              control.matches(':disabled') || control.getAttribute('aria-disabled') === 'true'
            const role = control.getAttribute('role')
            const label = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? ''
            const item = {
              index,
              tag: control.localName,
              role,
              label,
              disabled,
              hidden: controlHidden,
              bounds,
              scrollContained: false,
            }
            record.controls.push(item)
            if (controlHidden) continue
            interactiveMatches += 1
            const reference = `${scope.selector}[${matchIndex}] interactive[${index}]`
            inspectCoordinates(control, scope.selector, reference)
            if (control.closest('[inert], [aria-hidden="true"]'))
              issues.push({
                kind: 'rendered-interactive-semantically-hidden',
                severity: 'review-required',
                scope: scope.selector,
                element: reference,
                evidence: { label, bounds },
              })
            if (!bounds.width || !bounds.height) {
              issues.push({
                kind: 'interactive-has-no-measurable-box',
                severity: 'review-required',
                scope: scope.selector,
                element: reference,
                evidence: { label, bounds },
              })
              continue
            }
            let scrollportX: { left: number; right: number } | null = null
            let scrollportY: { top: number; bottom: number } | null = null
            for (
              let ancestor = control.parentElement;
              ancestor;
              ancestor = ancestor.parentElement
            ) {
              const computed = getComputedStyle(ancestor)
              const box = ancestor.getBoundingClientRect()
              const root = ancestor === document.documentElement
              const left = root ? 0 : box.left + ancestor.clientLeft
              const right = left + ancestor.clientWidth
              const top = root ? 0 : box.top + ancestor.clientTop
              const bottom = top + ancestor.clientHeight
              const xClipped = bounds.left < left - tolerance || bounds.right > right + tolerance
              const yClipped = bounds.top < top - tolerance || bounds.bottom > bottom + tolerance
              if (xClipped && ['auto', 'scroll'].includes(computed.overflowX)) {
                scrollportX ??= { left, right }
                if (left >= -tolerance && right <= document.documentElement.clientWidth + tolerance)
                  item.scrollContained = true
              }
              if (yClipped && ['auto', 'scroll'].includes(computed.overflowY))
                scrollportY ??= { top, bottom }
              const xHidden = xClipped && ['hidden', 'clip'].includes(computed.overflowX)
              const yHidden = yClipped && ['hidden', 'clip'].includes(computed.overflowY)
              const xProtected =
                scrollportX &&
                scrollportX.left >= left - tolerance &&
                scrollportX.right <= right + tolerance &&
                bounds.width <= scrollportX.right - scrollportX.left + tolerance
              const yProtected =
                scrollportY &&
                scrollportY.top >= top - tolerance &&
                scrollportY.bottom <= bottom + tolerance &&
                bounds.height <= scrollportY.bottom - scrollportY.top + tolerance
              if ((xHidden && !xProtected) || (yHidden && !yProtected))
                issues.push({
                  kind:
                    scrollportX || scrollportY
                      ? 'nested-scroll-reachability-needs-review'
                      : 'interactive-clipped-by-ancestor',
                  severity: scrollportX || scrollportY ? 'review-required' : 'fail',
                  scope: scope.selector,
                  element: reference,
                  evidence: {
                    label,
                    bounds,
                    ancestor: ancestor.localName,
                    ancestorBounds: rect(box),
                    overflowX: computed.overflowX,
                    overflowY: computed.overflowY,
                  },
                })
            }
            if (
              !item.scrollContained &&
              (bounds.left < -tolerance ||
                bounds.right > document.documentElement.clientWidth + tolerance)
            )
              issues.push({
                kind: 'interactive-outside-horizontal-viewport',
                severity: 'fail',
                scope: scope.selector,
                element: reference,
                evidence: { label, bounds },
              })
            // Native selection controls may have a larger associated label hit target: inspect that separately.
            const selectionControl =
              ['checkbox', 'switch', 'radio'].includes(role ?? '') ||
              control.matches('input[type="checkbox"],input[type="radio"]')
            if (
              minimumTarget !== null &&
              !disabled &&
              (bounds.width < minimumTarget || bounds.height < minimumTarget)
            )
              issues.push({
                kind: selectionControl
                  ? 'selection-control-associated-target-needs-measurement'
                  : 'target-below-requested-minimum',
                severity: selectionControl ? 'review-required' : 'fail',
                scope: scope.selector,
                element: reference,
                evidence: { label, bounds, minimumTarget },
              })
          }
        }
        coverage.push({
          selector: scope.selector,
          matches: matches.length,
          visibleMatches,
          interactiveMatches,
        })
        if (scope.visibility !== 'allow-hidden' && !visibleMatches)
          issues.push({
            kind: 'required-scope-has-zero-visible-matches',
            severity: 'review-required',
            scope: scope.selector,
            element: scope.selector,
            evidence: { matches: matches.length },
          })
        if (scope.expectInteractive && !interactiveMatches)
          issues.push({
            kind: 'required-scope-has-zero-visible-interactives',
            severity: 'review-required',
            scope: scope.selector,
            element: scope.selector,
            evidence: { matches: matches.length, visibleMatches },
          })
      }
      return {
        schema: 'venturi.design-reflow-evidence.v1',
        environment: {
          ...context,
          routeOrPage: location.href,
          observedAt: new Date().toISOString(),
          viewportOrCanvas: {
            width: innerWidth,
            height: innerHeight,
            documentWidth: document.documentElement.clientWidth,
            visualViewportScale: visualViewport?.scale ?? null,
            devicePixelRatio,
          },
          browserZoom: 'not-measured',
          pointerCoarse: matchMedia('(pointer: coarse)').matches,
        },
        options: { minimumTarget, tolerance },
        documentOverflow,
        coverage,
        records,
        issues,
        status: issues.some((issue) => issue.severity === 'fail')
          ? ('fail' as const)
          : issues.length
            ? ('review-required' as const)
            : ('pass' as const),
        limitations: [
          'Bounds are not hit-testing, overlap, reading-order, occlusion, embedded-document, closed-shadow-root, or full visual acceptance.',
          'Offscreen descendants within an intentional scroll container are recorded, not mistaken for page overflow.',
          'Hidden responsive content is recorded; required visible scope/control coverage cannot pass vacuously.',
          'Selection controls require associated-label hit-target evidence if target sizing is in scope.',
          'Visual viewport scale and devicePixelRatio do not establish real browser zoom.',
        ],
      }
    },
    {
      scopes,
      context,
      minimumTarget: options.minimumTarget ?? null,
      tolerance: options.tolerance ?? 1,
    }
  )
}
