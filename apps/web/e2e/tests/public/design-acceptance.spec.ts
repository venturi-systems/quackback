import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { TEST_ADMIN } from '../../fixtures/auth'
import { getPostWithOwnComment } from '../../utils/db-helpers'
import {
  assertDesignFixtureEnvironment,
  assertDesignFixtureEnvironmentSync,
} from '../../utils/design-fixture-guard'
import {
  measureReflow,
  measureTypography,
  type TypographyRegion,
} from '../../utils/design-acceptance'
import { measureRenderedFonts } from '../../utils/rendered-font-evidence'
import { withDesignBrowserZoom } from '../../utils/browser-zoom-actuator'
import { assertActualBrowserZoom } from '../../utils/browser-zoom-evidence'

/**
 * Design acceptance in the existing disposable cloud E2E lane.
 * Uses the existing disposable cloud E2E lane and its managed Chromium binary; no new CI job.
 * These assertions cover the explicitly declared regions/states, not the entire product.
 * A02 uses a temporary extension-backed browser context and independent CDP zoom evidence.
 * A07 retains touch-targets.spec.ts's five cases; it is not duplicated here.
 */
assertDesignFixtureEnvironmentSync()
const SOURCE = process.env.GITHUB_SHA!
const WIDTHS = [320, 390, 639, 640, 641, 767, 768, 769, 1023, 1024, 1025, 1440, 1920, 2560]
const ROUTES = ['feed', 'post', 'roadmap', 'changelog'] as const
type Route = (typeof ROUTES)[number]

test.use({ storageState: 'e2e/.auth/admin.json', locale: 'en-US' })
test.beforeEach(async ({ baseURL }) => {
  // This guard must precede any fixture helper, navigation or DOM interaction in this file.
  await assertDesignFixtureEnvironment(baseURL)
})

async function attach(testInfo: TestInfo, name: string, evidence: unknown) {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: 'application/json',
  })
}

async function openRoute(page: Page, route: Route, revealParticipation = true) {
  const path =
    route === 'post'
      ? (await getPostWithOwnComment(TEST_ADMIN.email)).path
      : route === 'feed'
        ? '/'
        : `/${route}`
  const response = await page.goto(path)
  expect(response, 'Required route must return a document response').not.toBeNull()
  expect(response!.status()).toBe(200)
  await expect(page.locator('header.portal-header')).toHaveCount(1)
  await expect(page.locator('#portal-main')).toBeVisible()
  await expect(page.getByTestId('venturi-site-footer')).toHaveCount(1)
  await page.waitForLoadState('networkidle')
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  if (route === 'feed') {
    await expect(page.locator('#feedback-title')).toBeVisible()
    // Both responsive copies are mounted. Open the applicable native disclosure,
    // then require actual visible text; hidden copies remain in the evidence inventory.
    const disclosure = page.locator('details.portal-participation-disclosure')
    if (revealParticipation && (await disclosure.isVisible())) {
      const summary = disclosure.locator('summary')
      await summary.click()
      await expect(disclosure).toHaveAttribute('open', '')
    }
    await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeVisible()
  }
  if (route === 'post') await expect(page.getByTestId('post-detail')).toBeVisible()
  if (route === 'roadmap' || route === 'changelog') {
    await expect(page.locator('#portal-main h1.portal-page-title')).toHaveText(
      route === 'roadmap' ? 'Roadmap' : 'Changelog'
    )
  }
  if (route === 'changelog')
    await expect(page.getByRole('link', { name: 'RSS Feed', exact: true })).toHaveAttribute(
      'href',
      '/changelog/feed'
    )
  if (route === 'changelog') {
    const entries = page.locator(
      '#portal-main article a[href^="/changelog/"] > h2[data-text-origin="user"]'
    )
    const empty = page.getByRole('heading', { name: 'No updates yet', exact: true })
    await expect(entries.first().or(empty)).toBeVisible()
    await expect(page.getByText('Loading changelog...', { exact: true })).toHaveCount(0)
  }
  if (route === 'roadmap') {
    const columns = page.locator('#portal-main .snap-center > [data-slot="card"]')
    const empty = page.getByRole('heading', { name: 'No roadmaps available', exact: true })
    await expect(columns.first().or(empty)).toBeVisible()
    if (await empty.isVisible()) {
      await expect(columns).toHaveCount(0)
    } else {
      const count = await columns.count()
      expect(count).toBeGreaterThan(0)
      for (let index = 0; index < count; index += 1) {
        const column = columns.nth(index)
        await expect(
          column.locator(':scope > [data-slot="card-header"] [data-slot="badge"]')
        ).toHaveText(/^\d+$/)
        await expect(column.locator('.animate-spin')).toHaveCount(0)
        await expect(column.getByRole('alert')).toHaveCount(0)
        const cards = column.locator('a.roadmap-card')
        const noItems = column.getByText('No items yet', { exact: true })
        // Offscreen columns within the intentional horizontal scroller are
        // valid; require settled content without mistaking it for viewport fit.
        await expect(cards.first().or(noItems)).toBeAttached()
      }
    }
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === 'running' &&
          Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
      )
    await Promise.all(finite.map((animation) => animation.finished))
  })
}

function feedRegions(
  locale = 'en-US',
  origin: TypographyRegion['origin'] = 'authored'
): TypographyRegion[] {
  return [
    { selector: '#feedback-title', profile: 'headline', origin, locale },
    { selector: '.portal-introduction > p', profile: 'short-copy', origin, locale },
    {
      selector: '.portal-introduction [data-text-profile="headline"]',
      profile: 'headline',
      origin,
      locale,
    },
    {
      selector: '.portal-introduction [data-text-profile="short-copy"]',
      profile: 'short-copy',
      origin,
      locale,
    },
  ]
}

async function recordReflow(page: Page, testInfo: TestInfo, state: string) {
  const evidence = await measureReflow(
    page,
    [
      { selector: 'header.portal-header', expectInteractive: true },
      { selector: '#portal-main' },
      { selector: '[data-testid="venturi-site-footer"]' },
    ],
    { artifactRevision: SOURCE, state }
  )
  await attach(testInfo, `reflow-${state}`, evidence)
  // Review-required findings cannot silently become passing acceptance.
  expect(evidence.issues, 'Resolve or specifically review every measured reflow finding').toEqual(
    []
  )
  return evidence
}

async function recordAuthoredFeedTypography(page: Page, testInfo: TestInfo, state: string) {
  const evidence = await measureTypography(page, feedRegions(), { artifactRevision: SOURCE, state })
  const paths = [
    ...new Set(
      evidence.findings.flatMap((finding) =>
        finding.lines.flatMap((line) => line.fragments.map((fragment) => fragment.nodePath))
      )
    ),
  ]
  const fonts = await measureRenderedFonts(page, paths, 'DM Sans')
  const afterFonts = await measureTypography(page, feedRegions(), {
    artifactRevision: SOURCE,
    state,
  })
  const binding = (snapshot: typeof evidence) => ({
    viewport: snapshot.environment.viewportOrCanvas,
    fontReadiness: snapshot.environment.fontReadiness,
    coverage: snapshot.coverage,
    findings: snapshot.findings.map(
      ({ elementOrRegion, selectedText, renderedText, bounds, font, lines, linePolicyStatus }) => ({
        elementOrRegion,
        selectedText,
        renderedText,
        bounds,
        font,
        lines,
        linePolicyStatus,
      })
    ),
  })
  const stableSnapshot = JSON.stringify(binding(evidence)) === JSON.stringify(binding(afterFonts))
  const scopedAcceptance =
    evidence.coverage.every((item) => item.status === 'measured') &&
    evidence.findings.every((finding) =>
      ['pass', 'exempt', 'not-applicable'].includes(finding.linePolicyStatus)
    ) &&
    fonts.status === 'pass' &&
    stableSnapshot
  await attach(testInfo, `typography-${state}`, {
    evidence,
    actualGlyphFonts: fonts,
    afterFonts,
    stableSnapshot,
    scopedAcceptance: scopedAcceptance ? 'pass' : 'review-required',
    scope: 'Only the declared feed introduction and participation copy at this measured state.',
    remainingCoverage:
      'Other routes, dialogs, material states, user/localized copy and real zoom need separate acceptance.',
  })
  expect(evidence.coverage.filter((item) => item.status !== 'measured')).toEqual([])
  expect(
    evidence.findings.filter((finding) =>
      ['fail', 'review-required'].includes(finding.linePolicyStatus)
    )
  ).toEqual([])
  expect(
    fonts.status,
    'Font readiness/computed font-family do not prove rendered glyph identity'
  ).toBe('pass')
  expect(
    stableSnapshot,
    'Text, line geometry or font state changed around platform-font measurements'
  ).toBe(true)
  expect(scopedAcceptance).toBe(true)
}

for (const width of WIDTHS) {
  for (const route of ROUTES) {
    test(`A01 ${route} geometry at actual ${width}px${route === 'feed' ? ' and A04 authored feed line profiles' : ''}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 })
      await openRoute(page, route)
      const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      expect(actual).toEqual({ width, height: 1000 })
      await recordReflow(page, testInfo, `${route}-${width}`)

      if (route === 'post') {
        const boxes = await page.evaluate(() => {
          const content = (selector: string) => {
            const element = document.querySelector(selector)
            if (!element) throw new Error(`Required region missing: ${selector}`)
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return {
              left: rect.left + parseFloat(style.paddingLeft),
              right: rect.right - parseFloat(style.paddingRight),
            }
          }
          return {
            detail: content('[data-testid="post-detail"]'),
            rail: content('header .portal-shell'),
            root: parseFloat(getComputedStyle(document.documentElement).fontSize),
          }
        })
        await attach(testInfo, `reading-start-${width}`, boxes)
        expect(Math.abs(boxes.detail.left - boxes.rail.left)).toBeLessThanOrEqual(1)
        expect(boxes.detail.right - boxes.detail.left).toBeLessThanOrEqual(72 * boxes.root + 1)
      }
      if (route === 'feed') await recordAuthoredFeedTypography(page, testInfo, `feed-${width}`)
    })
  }
}

async function recordZoomTextSpacing(page: Page, testInfo: TestInfo, state: string) {
  // Freeze the actual visible headings and paragraphs before applying stress.
  // Hidden responsive copies are excluded explicitly; disappearing measured copy fails.
  const inventory = await page
    .locator('#portal-main h1, #portal-main h2, #portal-main p')
    .evaluateAll((elements) =>
      elements
        .filter(
          (element) =>
            element instanceof HTMLElement &&
            element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
            element.textContent?.trim()
        )
        .map((element) => {
          const parts: string[] = []
          let current: Element | null = element
          while (current) {
            const parent: Element | null = current.parentElement
            const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1
            parts.unshift(`${current.localName}:nth-child(${index})`)
            current = parent
          }
          const declaredOrigin = element
            .closest('[data-text-origin]')
            ?.getAttribute('data-text-origin')
          const declaredProfile = element
            .closest('[data-text-profile]')
            ?.getAttribute('data-text-profile')
          if (
            declaredOrigin != null &&
            !['authored', 'user', 'localized'].includes(declaredOrigin)
          ) {
            throw new Error('Unknown text origin in zoom evidence')
          }
          if (
            declaredProfile != null &&
            !['headline', 'short-copy', 'prose'].includes(declaredProfile)
          ) {
            throw new Error('Unknown text profile in zoom evidence')
          }
          const semanticProfile =
            element.localName !== 'p'
              ? 'headline'
              : element.matches('.portal-introduction > p')
                ? 'short-copy'
                : 'prose'
          return {
            selector: parts.join(' > '),
            text: element.textContent,
            paragraph: element.localName === 'p',
            origin: (declaredOrigin ?? 'authored') as 'authored' | 'user' | 'localized',
            profile: (declaredProfile ?? semanticProfile) as 'headline' | 'short-copy' | 'prose',
            classification: {
              declaredOrigin,
              declaredProfile,
              fallback:
                'Unmarked text is authored; headings are headline, introduction is short-copy, other paragraphs prose.',
            },
          }
        })
    )
  expect(inventory.length, 'Every zoomed route must expose real readable copy').toBeGreaterThan(0)
  await stressRenderedText(page, 'spacing')
  const computed = []
  for (const item of inventory) {
    const element = page.locator(item.selector)
    await expect(element).toBeVisible()
    expect(await element.textContent()).toBe(item.text)
    const spacing = await element.evaluate((node) => {
      const style = getComputedStyle(node)
      const size = parseFloat(style.fontSize)
      return {
        line: parseFloat(style.lineHeight) / size,
        paragraph: parseFloat(style.marginBlockEnd) / size,
        letter: parseFloat(style.letterSpacing) / size,
        word: parseFloat(style.wordSpacing) / size,
      }
    })
    expect(spacing.line).toBeCloseTo(1.5, 2)
    if (item.paragraph) expect(spacing.paragraph).toBeCloseTo(2, 2)
    expect(spacing.letter).toBeCloseTo(0.12, 2)
    expect(spacing.word).toBeCloseTo(0.16, 2)
    computed.push({ ...item, spacing })
  }
  const typography = await measureTypography(
    page,
    inventory.map(({ selector, profile, origin }) => ({
      selector,
      profile,
      origin,
      locale: 'en-US',
    })),
    { artifactRevision: SOURCE, state, stress: 'actual browser zoom and text spacing' }
  )
  const clipping = typography.findings.flatMap((finding) =>
    finding.reasons.filter((reason) =>
      /clipp|mask|truncat|no-rendered-fragment|no-measurable-rendered-text/.test(reason)
    )
  )
  await attach(testInfo, `zoom-text-spacing-${state}`, {
    computed,
    typography,
    clipping,
    scope:
      'Visible route headings and paragraphs: effective spacing and clipping. Line-profile and font-identity acceptance remain separately measured.',
  })
  expect(typography.coverage.filter((item) => item.status !== 'measured')).toEqual([])
  expect(clipping).toEqual([])
}

for (const factor of [2, 4] as const) {
  for (const route of ROUTES) {
    test(`A02 ${route} at actual ${factor * 100}% browser zoom preserves reflow and text spacing`, async ({
      baseURL,
    }, testInfo) => {
      test.setTimeout(60_000)
      await withDesignBrowserZoom(
        { baseURL, viewport: { width: 1280, height: 1000 }, useAdminState: true },
        async ({ page, setZoom }) => {
          await openRoute(page, route, false)
          const before = await setZoom(factor)
          const cssWidth = await page.evaluate(() => innerWidth)
          expect(cssWidth).toBeCloseTo(1280 / factor, 0)
          const disclosure = page.locator('details.portal-participation-disclosure')
          if (route === 'feed' && (await disclosure.isVisible())) {
            await disclosure.locator('summary').click()
            await expect(disclosure).toHaveAttribute('open', '')
          }
          await recordReflow(page, testInfo, `${route}-zoom-${factor}`)
          await expect(page.locator('#portal-main')).toBeVisible()
          if (route === 'feed') await expect(page.locator('#feedback-title')).toBeVisible()
          if (route === 'post') {
            await expect(page.getByTestId('post-detail')).toBeVisible()
            await expect(page.locator('[data-testid="post-detail"] h1')).toBeVisible()
          }
          if (route === 'roadmap' || route === 'changelog') {
            const heading = page.locator('#portal-main h1.portal-page-title')
            await expect(heading).toBeVisible()
            await expect(heading).toHaveText(route === 'roadmap' ? 'Roadmap' : 'Changelog')
          }
          await recordZoomTextSpacing(page, testInfo, `${route}-zoom-${factor}`)
          await recordReflow(page, testInfo, `${route}-zoom-${factor}-spacing`)
          const toggle = page.locator('button[aria-controls="portal-mobile-navigation"]')
          if (factor === 4) {
            await expect(toggle).toBeVisible()
            await toggle.click()
            await expect(toggle).toHaveAttribute('aria-expanded', 'true')
            await expect(
              page.getByRole('navigation', { name: 'Mobile portal navigation', exact: true })
            ).toBeVisible()
            await recordReflow(page, testInfo, `${route}-zoom-${factor}-menu`)
            await page.keyboard.press('Escape')
            await expect(toggle).toHaveAttribute('aria-expanded', 'false')
            await expect(toggle).toBeFocused()
          } else {
            await expect(toggle).toBeHidden()
            await expect(
              page.getByRole('navigation', { name: 'Portal navigation', exact: true })
            ).toBeVisible()
          }
          const after = await assertActualBrowserZoom(page, factor)
          await attach(testInfo, `actual-browser-zoom-${route}-${factor}`, {
            source: SOURCE,
            route,
            factor,
            before,
            after,
            cssWidth,
            scope:
              'Actual browser zoom, text spacing, shell reflow and responsive menu on the isolated cloud fixture; no production acceptance.',
          })
        }
      )
    })
  }
}

for (const width of [639, 640, 641]) {
  test(`A01 navigation changes at actual ${width}px and remains operable`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await openRoute(page, 'feed')
    const toggle = page.locator('button[aria-controls="portal-mobile-navigation"]')
    if (width < 640) {
      await expect(toggle).toBeVisible()
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const navigation = page.getByRole('navigation', {
        name: 'Mobile portal navigation',
        exact: true,
      })
      await expect(navigation).toBeVisible()
      await recordReflow(page, testInfo, `menu-open-${width}`)
      await page.keyboard.press('Escape')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await navigation.getByRole('link', { name: 'Roadmap', exact: true }).click()
      await expect(page).toHaveURL(/\/roadmap(?:[/?#]|$)/)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    } else {
      await expect(toggle).toBeHidden()
      const navigation = page.getByRole('navigation', { name: 'Portal navigation', exact: true })
      await expect(navigation).toBeVisible()
      await navigation.getByRole('link', { name: 'Roadmap', exact: true }).click()
      await expect(page).toHaveURL(/\/roadmap(?:[/?#]|$)/)
    }
  })
}

type TextStress = 'spacing' | 'short-copy' | 'expanded-copy'

for (const width of [1024, 1440]) {
  test(`A03 long author name and expanded post paragraphs at ${width}px remain readable`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await openRoute(page, 'post')
    const authorSelector =
      '[data-testid="post-detail"] aside > div.space-y-5 > div.flex.items-center.justify-between > div.gap-1\\.5 > span.text-sm.font-medium.text-foreground'
    const author = page.locator(authorSelector)
    await expect(author).toHaveCount(1)
    await expect(author).toBeVisible()
    const paragraphSelector = '[data-testid="post-detail"] div[data-text-origin="user"] p'
    const paragraphs = page.locator(paragraphSelector)
    expect(
      await paragraphs.count(),
      'Existing post fixture must contain actual paragraph text'
    ).toBeGreaterThan(0)
    const nameChange = await author.evaluate((element) => {
      const nodes = Array.from(element.childNodes).filter(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
      )
      if (nodes.length !== 1)
        throw new Error('Author fixture requires one direct text node; preserve richer content')
      const before = nodes[0].textContent
      nodes[0].textContent = 'Alexandra Catherine Montgomery-Wellington'
      return { before, after: nodes[0].textContent }
    })
    const bodyChanges = await paragraphs.evaluateAll((elements) =>
      elements
        .map((element) => {
          const changes: Array<{ before: string; after: string }> = []
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode as Text
            if (!node.data.trim() || node.parentElement?.closest('svg, [aria-hidden="true"]'))
              continue
            const before = node.data
            node.data = `${before.trim()} ${before.trim()}`
            changes.push({ before, after: node.data })
          }
          return changes
        })
        .flat()
    )
    expect(bodyChanges.length).toBeGreaterThan(0)
    await recordReflow(page, testInfo, `long-name-body-${width}`)
    const typography = await measureTypography(
      page,
      [
        { selector: authorSelector, profile: 'short-copy', origin: 'user', locale: 'en-US' },
        { selector: paragraphSelector, profile: 'prose', origin: 'user', locale: 'en-US' },
      ],
      {
        artifactRevision: SOURCE,
        state: `long-name-body-${width}`,
        stress: 'page-local fictional name and doubled existing text nodes',
      }
    )
    const clipping = typography.findings.flatMap((finding) =>
      finding.reasons.filter((reason) =>
        /clipp|mask|truncat|no-rendered-fragment|no-measurable-rendered-text/.test(reason)
      )
    )
    await attach(testInfo, `long-name-body-${width}`, {
      nameChange,
      bodyChanges,
      typography,
      clipping,
      acceptance:
        'Measured geometry/copy-clipping only. User-content line profiles remain review-required; no database content is changed.',
    })
    expect(typography.coverage.filter((item) => item.status !== 'measured')).toEqual([])
    expect(clipping).toEqual([])
  })
}

async function stressRenderedText(page: Page, mode: TextStress) {
  const changes = await page.evaluate((mode) => {
    const changed: Array<{
      selector: string
      before: string
      after: string
      characterRatio: number
    }> = []
    const shortCopy: Record<string, string> = {
      Feedback: 'Ideas',
      'Share an idea, support a request, and follow what the team is working on.':
        'Share ideas and follow progress.',
      'Explore feedback': 'Explore ideas',
      'Share your perspective': 'Contribute',
      'The team manages progress': 'Track progress',
      'Read published ideas and follow progress on the roadmap.': 'Read ideas and follow progress.',
      'Your board access determines whether you can submit, vote, or comment. Signing in does not grant team access.':
        'Your board access controls participation.',
      'Only team members and administrators can review submissions, move roadmap items, or change their status.':
        'The team reviews ideas and manages progress.',
      Roadmap: 'Plans',
      Changelog: 'News',
    }
    // Exact 30–50% label expansion, distinct from larger whole-sentence body stress.
    const expandedLabels: Record<string, string> = {
      Feedback: 'All feedback',
      Roadmap: 'Plan ahead',
      Changelog: 'Release notes',
      Menu: 'Browse',
    }
    const targets = [
      '#feedback-title',
      '.portal-introduction > p',
      '.portal-introduction [data-text-profile]',
      'header button',
      'header nav a',
    ]
    if (mode !== 'spacing') {
      for (const selector of targets) {
        for (const element of document.querySelectorAll(selector)) {
          if (
            !(element instanceof HTMLElement) ||
            !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
          )
            continue
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode as Text
            if (
              !node.data.trim() ||
              node.parentElement?.closest('svg, [aria-hidden="true"], .sr-only')
            )
              continue
            const before = node.data
            // Mutate text nodes only: retain icons, inline descendants, buttons and handlers.
            const key = before.trim()
            const body = element.matches(
              '.portal-introduction > p, [data-text-profile="short-copy"]'
            )
            const after =
              mode === 'short-copy'
                ? shortCopy[key]
                : (expandedLabels[key] ?? (body ? `${key} ${key}` : undefined))
            if (!after) continue
            node.data = after
            changed.push({ selector, before, after, characterRatio: after.length / key.length })
          }
        }
      }
    }
    return changed
  }, mode)
  await page.addStyleTag({
    content: `
    header.portal-header *, #portal-main *, [data-testid="venturi-site-footer"] * {
      line-height: 1.5 !important;
      letter-spacing: 0.12em !important;
      word-spacing: 0.16em !important;
    }
    #portal-main p { margin-block-end: 2em !important; }
  `,
  })
  return changes
}

for (const width of [320, 768, 1440]) {
  for (const mode of ['spacing', 'short-copy', 'expanded-copy'] as const) {
    test(`A03 ${mode} at ${width}px preserves feed geometry and filter operation`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 })
      await openRoute(page, 'feed')
      const changes = await stressRenderedText(page, mode)
      await attach(testInfo, `text-stress-${mode}-${width}`, {
        mode,
        changes,
        scope:
          'Page-local rendered text only; no customer content or database writes; this is not a translated catalog test.',
        policy:
          'Accessible reflow takes priority; stress typography requires specific review, not a blanket ratio waiver.',
      })
      if (mode !== 'spacing') expect(changes.length).toBeGreaterThan(0)
      if (mode === 'expanded-copy') {
        const labelChanges = changes.filter((item) =>
          ['Feedback', 'Roadmap', 'Changelog', 'Menu'].includes(item.before.trim())
        )
        expect(labelChanges.length).toBeGreaterThan(0)
        for (const item of labelChanges) {
          expect(item.characterRatio).toBeGreaterThanOrEqual(1.3)
          expect(item.characterRatio).toBeLessThanOrEqual(1.5)
        }
        expect(changes.some((item) => item.characterRatio >= 2)).toBe(true)
      }
      const spacing = await page.locator('.portal-introduction > p').evaluate((element) => {
        const style = getComputedStyle(element)
        const size = parseFloat(style.fontSize)
        return {
          line: parseFloat(style.lineHeight) / size,
          paragraph: parseFloat(style.marginBlockEnd) / size,
          letter: parseFloat(style.letterSpacing) / size,
          word: parseFloat(style.wordSpacing) / size,
        }
      })
      expect(spacing.line).toBeCloseTo(1.5, 2)
      expect(spacing.paragraph).toBeCloseTo(2, 2)
      expect(spacing.letter).toBeCloseTo(0.12, 2)
      expect(spacing.word).toBeCloseTo(0.16, 2)
      await recordReflow(page, testInfo, `${mode}-${width}`)
      const stressedTypography = await measureTypography(page, feedRegions(), {
        artifactRevision: SOURCE,
        state: `${mode}-${width}`,
        stress: mode,
      })
      const clippingFindings = stressedTypography.findings.flatMap((finding) =>
        finding.reasons
          .filter((reason) =>
            /clipp|mask|truncat|no-rendered-fragment|no-measurable-rendered-text/.test(reason)
          )
          .map((reason) => ({ element: finding.elementOrRegion, reason }))
      )
      await attach(testInfo, `stressed-copy-measurement-${mode}-${width}`, {
        stressedTypography,
        clippingFindings,
        acceptance:
          'This case requires complete measured copy and no clipping findings. Stress line ratios and glyph identity remain specific review obligations, not waived acceptance.',
      })
      expect(stressedTypography.coverage.filter((item) => item.status !== 'measured')).toEqual([])
      expect(
        clippingFindings,
        'Non-interactive copy must remain readable under text stress'
      ).toEqual([])
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      const category = page.getByRole('button', { name: 'Vote count', exact: true })
      await expect(category).toBeVisible()
      await category.click()
      const choice = page
        .locator('[data-slot="popover-content"] [data-slot="command-item"]')
        .filter({ hasText: /^5\+ votes$/ })
      await expect(choice).toBeVisible()
      await choice.click()
      await expect(page).toHaveURL(/[?&]minVotes=5(?:&|$)/)
      await expect(page.getByRole('region', { name: 'Active filters', exact: true })).toBeVisible()
    })
  }
}

for (const { locale, language, direction } of [
  { locale: 'ar', language: 'ar', direction: 'rtl' },
  { locale: 'zh-CN', language: 'zh-CN', direction: 'ltr' },
]) {
  test.describe(`A05 real ${locale} catalog`, () => {
    test.use({ locale })
    for (const width of [320, 768, 1440]) {
      test(`document direction and feed geometry at ${width}px; typography review evidence`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 })
        await page.goto('/')
        await expect(page.locator('html')).toHaveAttribute('lang', language)
        await expect(page.locator('html')).toHaveAttribute('dir', direction)
        await expect(page.locator('#feedback-title')).toBeVisible()
        const disclosure = page.locator('details.portal-participation-disclosure')
        if (await disclosure.isVisible()) await disclosure.locator('summary').click()
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        const list = page.locator('#portal-main .mt-5[aria-busy]')
        await expect(list).toHaveCount(1)
        await expect(list).toHaveAttribute('aria-busy', 'false')
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === 'running' &&
                  Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
              )
              .map((animation) => animation.finished)
          )
        })
        await recordReflow(page, testInfo, `${locale}-${width}`)
        const typography = await measureTypography(page, feedRegions(locale, 'localized'), {
          artifactRevision: SOURCE,
          state: `${locale}-${width}`,
        })
        await attach(testInfo, `localized-review-${locale}-${width}`, {
          typography,
          acceptance:
            'REVIEW_REQUIRED: this test asserts catalog direction and geometry only; glyph-font and localized typography dispositions are still required.',
        })
        expect(typography.coverage.filter((item) => item.status !== 'measured')).toEqual([])
        expect(await page.locator('#feedback-title').innerText()).not.toBe('Feedback')
      })
    }
  })
}

test('A06 keyboard focus, forced colors and reduced motion retain the public light register', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'active', reducedMotion: 'reduce' })
  await openRoute(page, 'feed', false)
  // Public pages intentionally keep the light register even under dark OS media.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('html')).toHaveAttribute('data-venturi-web-theme', 'light')
  const toggle = page.locator('button[aria-controls="portal-mobile-navigation"]')
  let reachedToggle = false
  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press('Tab')
    if (await toggle.evaluate((element) => element === document.activeElement)) {
      reachedToggle = true
      break
    }
  }
  expect(reachedToggle, 'Menu must be reachable through the actual keyboard sequence').toBe(true)
  const focus = await toggle.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      focused: element === document.activeElement,
      focusVisible: element.matches(':focus-visible'),
      outline: style.outlineStyle,
      width: style.outlineWidth,
      color: style.outlineColor,
      transition: style.transitionDuration,
      animation: style.animationDuration,
    }
  })
  await attach(testInfo, 'focus-motion-media', focus)
  expect(focus.focusVisible).toBe(true)
  if (focus.outline !== 'none') {
    expect(parseFloat(focus.width)).toBeGreaterThan(0)
  }
  for (const value of [focus.transition, focus.animation]) {
    for (const duration of value.split(',')) {
      const seconds = parseFloat(duration) * (duration.trim().endsWith('ms') ? 0.001 : 1)
      expect(seconds).toBeLessThanOrEqual(0.00002)
    }
  }
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await recordReflow(page, testInfo, 'forced-colors-keyboard-menu')
  await page.keyboard.press('Escape')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toBeFocused()
})

test('A09 vote-count filter uses actual command-item semantics and survives reload', async ({
  page,
}, testInfo) => {
  await openRoute(page, 'feed')
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.getByRole('button', { name: 'Vote count', exact: true }).click()
  const choice = page
    .locator('[data-slot="popover-content"] [data-slot="command-item"]')
    .filter({ hasText: /^5\+ votes$/ })
  await expect(choice).toHaveCount(1)
  await choice.click()
  await expect(page).toHaveURL(/[?&]minVotes=5(?:&|$)/)
  const active = page.getByRole('region', { name: 'Active filters', exact: true })
  await expect(active).toBeVisible()
  await expect(active).toContainText('5+ votes')
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(active).toBeVisible()
  await expect(active).toContainText('5+ votes')
  await attach(testInfo, 'filter-state-after-reload', {
    url: page.url(),
    text: await active.innerText(),
    writes: 'No post, comment or vote is submitted.',
  })
})

for (const width of [320, 1440]) {
  for (const route of ['feed', 'roadmap'] as const) {
    test(`A10 ${route} search has persistent labels and keyboard recovery at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 })
      await openRoute(page, route)
      const trigger = page.locator('#portal-main').getByRole('button', { name: 'Search', exact: true })
      await trigger.click()
      const search = page.getByRole('textbox', { name: 'Search', exact: true })
      await expect(search).toBeFocused()
      await search.fill('connector')
      await expect(page.locator('label').filter({ hasText: /^Search$/ })).toBeVisible()
      await recordReflow(page, testInfo, `${route}-search-open-${width}`)
      await page.keyboard.press('Escape')
      await expect(search).toBeHidden()
      await expect(trigger).toBeFocused()
      await trigger.click()
      await expect(search).toHaveValue('connector')
      await search.press('Enter')
      await expect(page).toHaveURL(/[?&]search=connector(?:&|$)/)
      await expect(trigger).toBeFocused()
      await trigger.click()
      await page.getByRole('button', { name: 'Clear search', exact: true }).click()
      await expect(page).not.toHaveURL(/[?&]search=/)
      await expect(trigger).toBeFocused()
      if (route === 'feed') {
        const top = page.getByRole('button', { name: 'Top', exact: true })
        await top.click()
        await expect(top).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByRole('button', { name: 'Trending', exact: true })).toHaveAttribute(
          'aria-pressed',
          'false'
        )
      }
    })
  }
}

test('A11 empty search recovery preserves the selected board and sort', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openRoute(page, 'feed')
  await page.locator('#portal-main aside nav button').nth(1).click()
  await expect(page).toHaveURL(/[?&]board=/)
  const board = new URL(page.url()).searchParams.get('board')
  expect(board).toBeTruthy()
  const query = new URLSearchParams({
    board: board!,
    sort: 'top',
    search: 'zz-no-matching-feedback-a11',
    minVotes: '999999',
  })
  await page.goto(`/?${query}`)
  const status = page.locator('#portal-main [role="status"]')
  await expect(status).toHaveText('0 posts shown')
  await expect(page.getByText('Search: zz-no-matching-feedback-a11', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBeNull()
  const restored = new URL(page.url()).searchParams
  expect(restored.get('minVotes')).toBeNull()
  expect(restored.get('board')).toBe(board)
  expect(restored.get('sort')).toBe('top')
  await expect(status).toHaveText(/\d+ posts? shown/)
  await expect(page.locator('#portal-main').getByRole('button', { name: 'Search', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Clear all', exact: true })).toBeHidden()
})
