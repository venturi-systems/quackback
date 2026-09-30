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
      page.getByRole('heading', { level: 1, name: 'Help shape Acme Corp' })
    ).toBeVisible()
    const roles = page.locator('details.portal-gate__roles')
    const summary = roles.locator('summary')
    // Owner decision 5 (landing-page#2309): the page states who can do what
    // when it loads. The disclosure is open by default and folds on demand.
    await expect(roles).toHaveAttribute('open', '')
    await expect(page.locator('.portal-roles__grid')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Contributor', exact: true })).toBeVisible()
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
    await expect(roles).not.toHaveAttribute('open', '')
    await expect(page.locator('.portal-roles__grid')).toBeHidden()
    await page.keyboard.press('Space')
    await expect(roles).toHaveAttribute('open', '')
    await expect(page.getByRole('heading', { name: 'Contributor', exact: true })).toBeVisible()
    await expect(summary).toBeFocused()

    const records = []
    for (const width of [
      320, 390, 639, 640, 641, 767, 768, 769, 1023, 1024, 1025, 1440, 1920, 2560,
    ]) {
      await page.setViewportSize({ width, height: 1000 })
      // Measured in the state the page loads in: the explanation open.
      await expect(roles).toHaveAttribute('open', '')
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
              '.portal-gate__layout h1, .portal-gate__layout h2, .portal-gate__layout h3, .portal-gate__lead, .portal-gate__access, .portal-gate .portal-roles p, .portal-gate .portal-roles li'
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
      // The entry is one centered component at every width; the form is bounded,
      // while the public shell and marketing footer retain their full-width gutters.
      expect(geometry.form.y).toBeGreaterThanOrEqual(geometry.intro.y + geometry.intro.height)
      expect(Math.abs(geometry.form.x + geometry.form.width / 2 - width / 2)).toBeLessThanOrEqual(1)
      const typography = await measureTypography(
        page,
        [
          {
            selector:
              '.portal-gate__title, .portal-gate__signin-title, .portal-gate__roles-summary h2, .portal-gate .portal-roles__role',
            profile: 'headline',
            origin: 'authored',
            locale: 'en-US',
          },
          {
            selector:
              '.portal-gate__lead, .portal-gate__access, .portal-gate .portal-roles__who, .portal-gate .portal-roles__list li, .portal-gate .portal-roles__note',
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
      await expect(roles).not.toHaveAttribute('open', '')
      const compact = await page.evaluate(() => {
        const layout = document.querySelector('.portal-gate__layout')!.getBoundingClientRect()
        const footer = document.querySelector('.venturi-landing-footer')!.getBoundingClientRect()
        const form = document.querySelector('.portal-gate__form')!.getBoundingClientRect()
        return {
          gap: footer.top - layout.bottom,
          formWidth: form.width,
          targets: Array.from(document.querySelectorAll('.venturi-landing-footer a')).map(
            (element) => {
              const rect = element.getBoundingClientRect()
              return { text: element.textContent, width: rect.width, height: rect.height }
            }
          ),
        }
      })
      expect(compact.gap).toBeLessThanOrEqual(40)
      expect(compact.formWidth).toBeLessThanOrEqual(416)
      for (const target of compact.targets) {
        expect(target.width, target.text ?? '').toBeGreaterThanOrEqual(44)
        expect(target.height, target.text ?? '').toBeGreaterThanOrEqual(44)
      }
      await expect(page.getByRole('link', { name: 'Software notices' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Source code (AGPL-3.0)' })).toHaveCount(0)
      if ([390, 1440, 2560].includes(width)) {
        await testInfo.attach(`entry-folded-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
      }
      await summary.click()
      await expect(roles).toHaveAttribute('open', '')
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
          // The explanation is open on load, so the reflow check covers it.
          await expect(zoomPage.locator('details.portal-gate__roles')).toHaveAttribute('open', '')
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
              { selector: '.venturi-landing-footer', expectInteractive: true },
            ],
            {
              artifactRevision: process.env.GITHUB_SHA!,
              state: `entry-zoom-${factor}`,
              stress: 'actual browser zoom and text spacing',
            }
          )
          expect(reflow.issues).toEqual([])
          await expect(
            zoomPage.getByRole('heading', { level: 1, name: 'Help shape Acme Corp' })
          ).toBeVisible()
          await expect(zoomPage.getByLabel(/email/i)).toBeVisible()
          await testInfo.attach(`entry-zoom-${factor}`, {
            body: Buffer.from(JSON.stringify({ zoom, reflow })),
            contentType: 'application/json',
          })
        }
      )
    }
    // The quiet utility link must reach an anonymous source offer, including
    // the exact version served by this build, without entering a sign-in flow.
    await page.getByRole('link', { name: 'Software notices' }).click()
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
