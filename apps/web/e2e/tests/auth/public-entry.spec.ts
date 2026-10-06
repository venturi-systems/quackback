/**
 * REQ-FEEDBACK-ENTRY: this acceptance has no dependency on the serial login
 * journeys. Keep it in its own file so a tolerated login failure cannot skip
 * the responsive typography, keyboard disclosure, and actual zoom checks.
 */
import { test, expect } from '@playwright/test'
import { assertDesignFixtureEnvironment } from '../../utils/design-fixture-guard'
import { measureTypography, measureReflow } from '../../utils/design-acceptance'
import { measureFocusIndicator } from '../../utils/forced-colors-focus'
import { measureRenderedFonts } from '../../utils/rendered-font-evidence'
import { withDesignBrowserZoom } from '../../utils/browser-zoom-actuator'
import {
  flushMagicLinkRateLimit,
  setPortalAuthMethods,
  setPortalVisibility,
} from '../../utils/access-helpers'

test.beforeAll(() => {
  flushMagicLinkRateLimit()
  setPortalVisibility('public')
  setPortalAuthMethods('restore')
})

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies()
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
})

/** REQ-FEEDBACK-ENTRY: responsive public entry, with the existing auth path intact. */
test('(3a) public entry preserves readable type, keyboard disclosure and reflow', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000)
  await assertDesignFixtureEnvironment(baseURL)
  setPortalVisibility('authenticated')
  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(
      page.getByRole('heading', { level: 1, name: 'Share feedback with Acme Corp' })
    ).toBeVisible()
    const help = page.locator('details[data-public-sign-in-help]')
    const summary = help.locator('summary')
    // REQ-FEEDBACK-AUTH-VIEWPORT: native sign-in help is optional and the full compact footer remains present.
    await expect(help).not.toHaveAttribute('open', '')
    await expect(page.getByText('Who can do what', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Software notices' })).toHaveCount(1)
    await expect(page.getByRole('navigation', { name: 'Legal and sitemap' })).toHaveCount(1)
    const initialViewports = []
    try {
      for (const [width, height] of [
        [1440, 900],
        [1366, 768],
        [1280, 720],
        [768, 1024],
        [390, 844],
        [375, 667],
      ]) {
        await page.setViewportSize({ width, height })
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        const initial = await page.evaluate(() => {
          const root = document.documentElement
          const layout = document.querySelector('.portal-gate__layout')!.getBoundingClientRect()
          const footer = document.querySelector('.venturi-footer')!.getBoundingClientRect()
          return {
            width: innerWidth,
            height: innerHeight,
            documentWidth: root.scrollWidth,
            documentHeight: root.scrollHeight,
            clientWidth: root.clientWidth,
            layoutTop: layout.top,
            layoutBottom: layout.bottom,
            footerHeight: footer.height,
            footerBottom: footer.bottom,
            footerTop: footer.top,
            footerNavWidth: document
              .querySelector('.venturi-footer__legal')!
              .getBoundingClientRect().width,
            footerLinks: Array.from(document.querySelectorAll('.venturi-footer a')).map((link) => {
              const style = getComputedStyle(link)
              return {
                text: link.textContent,
                box: link.getBoundingClientRect().toJSON(),
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                letterSpacing: style.letterSpacing,
                fontOpticalSizing: style.fontOpticalSizing,
                fontVariationSettings: style.fontVariationSettings,
              }
            }),
            overflow: getComputedStyle(root).overflowY,
          }
        })
        // Preserve evidence for the failing viewport before assertions run.
        const footerFonts = await measureRenderedFonts(
          page,
          Array.from(
            { length: 5 },
            (_, index) => '.venturi-footer__legal li:nth-child(' + (index + 2) + ') a'
          )
        )
        initialViewports.push({
          ...initial,
          browserVersion: page.context().browser()?.version(),
          footerFonts,
        })
        expect(initial.documentWidth).toBeLessThanOrEqual(width)
        expect(initial.layoutTop).toBeGreaterThanOrEqual(0)
        // Natural vertical scrolling preserves readable text on short screens.
        // The footer ends the document, without an empty band after it.
        expect(Math.abs(initial.footerBottom - initial.documentHeight)).toBeLessThanOrEqual(1)
        expect(initial.footerTop).toBeGreaterThanOrEqual(initial.layoutBottom)
        const footerGap = initial.footerTop - initial.layoutBottom
        // A short page can use the remaining viewport height to pin its footer.
        // Once content needs scrolling, only the designed bottom padding remains.
        expect(footerGap).toBeLessThanOrEqual(
          Math.max(72, height - initial.layoutBottom - initial.footerHeight) + 1
        )
        expect(initial.layoutTop).toBeLessThanOrEqual(160)
        expect(initial.overflow).not.toMatch(/hidden|clip/)
      }
    } finally {
      await testInfo.attach('entry-initial-viewport', {
        body: Buffer.from(JSON.stringify(initialViewports)),
        contentType: 'application/json',
      })
    }
    await summary.focus()
    const focus = await measureFocusIndicator(summary)
    expect(
      focus.focused && focus.focusVisible && focus.visible && focus.unclipped && focus.unobscured
    ).toBe(true)
    expect(focus.width).toBeGreaterThanOrEqual(2)
    expect(focus.alpha).toBeGreaterThan(0)
    await testInfo.attach('entry-disclosure-focus', {
      body: Buffer.from(JSON.stringify(focus)),
      contentType: 'application/json',
    })
    await page.keyboard.press('Enter')
    await expect(help).toHaveAttribute('open', '')
    await expect(help.getByRole('link', { name: 'Reload this page' })).toBeVisible()
    await page.keyboard.press('Space')
    await expect(help).not.toHaveAttribute('open', '')
    await expect(page.getByText('Who can do what', { exact: true })).toHaveCount(0)
    await expect(summary).toBeFocused()
    await page.keyboard.press('Enter')

    const records = []
    for (const width of [
      320, 390, 639, 640, 641, 767, 768, 769, 1023, 1024, 1025, 1440, 1920, 2560,
    ]) {
      await page.setViewportSize({ width, height: 1000 })
      // Expanded native recovery help remains readable after the visitor requests it.
      await expect(help).toHaveAttribute('open', '')
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const geometry = await page.evaluate(() => {
        const intro = document.querySelector('.portal-gate__layout > .portal-gate__intro')!
        const form = document.querySelector('.portal-gate__signin')!
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          intro: intro.getBoundingClientRect().toJSON(),
          form: form.getBoundingClientRect().toJSON(),
          text: Array.from(
            document.querySelectorAll(
              '.portal-gate__layout h1, .portal-gate__lead, .portal-gate__access, [data-public-sign-in-help] p'
            )
          ).map((element) => ({
            text: element.textContent,
            size: parseFloat(getComputedStyle(element).fontSize),
            heading: /^H[1-6]$/.test(element.tagName),
          })),
        }
      })
      expect(geometry.document).toBeLessThanOrEqual(width)
      for (const item of geometry.text)
        expect(item.size, item.text ?? '').toBeGreaterThanOrEqual(item.heading ? 18 : 16)
      // Desktop uses adjacent context and sign-in columns; narrow screens
      // keep the form on the same reading rail below the introduction.
      if (width >= 768) {
        expect(geometry.form.x).toBeGreaterThanOrEqual(geometry.intro.right)
        expect(Math.abs(geometry.form.y - geometry.intro.y)).toBeLessThanOrEqual(8)
      } else {
        expect(geometry.form.y).toBeGreaterThanOrEqual(geometry.intro.bottom)
        expect(Math.abs(geometry.form.x - geometry.intro.x)).toBeLessThanOrEqual(1)
      }
      const typography = await measureTypography(
        page,
        [
          {
            selector: '.portal-gate__title',
            profile: 'headline',
            origin: 'authored',
            locale: 'en-US',
          },
          {
            selector: '.portal-gate__access',
            profile: 'short-copy',
            origin: 'authored',
            locale: 'en-US',
          },
        ],
        { artifactRevision: process.env.GITHUB_SHA!, state: `entry-${width}` }
      )
      expect(typography.coverage.every((item) => item.status === 'measured')).toBe(true)
      expect(
        typography.findings.filter((item) =>
          ['fail', 'review-required'].includes(item.linePolicyStatus)
        )
      ).toEqual([])
      const fonts = await measureRenderedFonts(
        page,
        typography.findings.map((item) => item.elementOrRegion)
      )
      expect(fonts.status).toBe('pass')
      records.push({ width, geometry, typography, fonts })
      if ([390, 1440, 2560].includes(width)) {
        await testInfo.attach(`entry-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
      }
      // The folded state, then open again for the next width.
      await summary.click()
      await expect(help).not.toHaveAttribute('open', '')
      const compact = await page.evaluate(() => {
        const form = document.querySelector('.portal-gate__form')!.getBoundingClientRect()
        return {
          formWidth: form.width,
          targets: Array.from(document.querySelectorAll('.venturi-footer a')).map((element) => {
            const rect = element.getBoundingClientRect()
            return { text: element.textContent, width: rect.width, height: rect.height }
          }),
        }
      })
      expect(compact.formWidth).toBeLessThanOrEqual(416)
      expect(compact.targets).toHaveLength(19)
      for (const target of compact.targets) {
        expect(target.width, target.text ?? '').toBeGreaterThanOrEqual(44)
        expect(target.height, target.text ?? '').toBeGreaterThanOrEqual(44)
      }
      await expect(page.getByRole('link', { name: 'Software notices' })).toHaveCount(1)
      await expect(page.getByRole('link', { name: 'Software notices', exact: true })).toBeVisible()
      if ([390, 1440, 2560].includes(width)) {
        await testInfo.attach(`entry-folded-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
      }
      await summary.click()
      await expect(help).toHaveAttribute('open', '')
    }
    await testInfo.attach('entry-layout-evidence', {
      body: Buffer.from(JSON.stringify(records)),
      contentType: 'application/json',
    })

    for (const factor of [2, 4] as const) {
      await withDesignBrowserZoom(
        { baseURL, viewport: { width: 1280, height: 1000 } },
        async ({ page: zoomPage, setZoom }) => {
          await zoomPage.goto('/')
          await expect(zoomPage.locator('.portal-gate__layout')).toBeVisible()
          const zoom = await setZoom(factor)
          await expect(zoomPage.locator('details[data-public-sign-in-help]')).not.toHaveAttribute(
            'open',
            ''
          )
          await zoomPage.locator('details[data-public-sign-in-help] summary').click()
          await expect(zoomPage.locator('details[data-public-sign-in-help]')).toHaveAttribute(
            'open',
            ''
          )
          await zoomPage.addStyleTag({
            content: `
            .portal-gate--entry * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
            .portal-gate--entry p { margin-block-end: 2em !important; }
          `,
          })
          const reflow = await measureReflow(
            zoomPage,
            [
              { selector: '.portal-gate__layout', expectInteractive: true },
              { selector: '.venturi-footer', expectInteractive: true },
            ],
            {
              artifactRevision: process.env.GITHUB_SHA!,
              state: `entry-zoom-${factor}`,
              stress: 'actual browser zoom and text spacing',
            }
          )
          expect(reflow.issues).toEqual([])
          await expect(
            zoomPage.getByRole('heading', { level: 1, name: 'Share feedback with Acme Corp' })
          ).toBeVisible()
          await expect(zoomPage.getByLabel(/email/i)).toBeVisible()
          await testInfo.attach(`entry-zoom-${factor}`, {
            body: Buffer.from(JSON.stringify({ zoom, reflow })),
            contentType: 'application/json',
          })
        }
      )
    }
    // Public notices retain access to the exact build source without provider authentication.
    await expect(page.getByRole('link', { name: 'Software notices', exact: true })).toHaveAttribute(
      'href',
      '/software-notices'
    )
    await page.getByRole('link', { name: 'Software notices', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Software notices', exact: true })).toBeVisible()
    const source = await page
      .getByRole('link', { name: 'View the source for this version' })
      .getAttribute('href')
    expect(source).toMatch(
      /^https:\/\/github\.com\/venturi-systems\/quackback\/tree\/[0-9a-f]{7,40}$/
    )
    expect(process.env.GITHUB_SHA!.startsWith(source!.split('/').at(-1)!)).toBe(true)
  } finally {
    setPortalVisibility('public')
  }
})
