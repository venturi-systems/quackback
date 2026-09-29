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
    await expect(roles).not.toHaveAttribute('open', '')
    await expect(page.locator('.portal-roles__grid')).toBeHidden()
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
    await expect(roles).toHaveAttribute('open', '')
    await expect(page.getByRole('heading', { name: 'Contributor', exact: true })).toBeVisible()
    await page.keyboard.press('Space')
    await expect(roles).not.toHaveAttribute('open', '')
    await expect(summary).toBeFocused()

    const records = []
    for (const width of [
      320, 390, 639, 640, 641, 767, 768, 769, 1023, 1024, 1025, 1440, 1920, 2560,
    ]) {
      await page.setViewportSize({ width, height: 1000 })
      await summary.click()
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
      if (width >= 1024) {
        expect(geometry.form.x).toBeGreaterThan(geometry.intro.x + geometry.intro.width)
        expect(Math.abs(geometry.form.y - geometry.intro.y)).toBeLessThanOrEqual(1)
      } else {
        expect(geometry.form.y).toBeGreaterThanOrEqual(geometry.intro.y + geometry.intro.height)
      }
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
      await summary.click()
      if ([390, 1440, 2560].includes(width)) {
        await testInfo.attach(`entry-initial-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
      }
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
          await zoomPage.locator('.portal-gate__roles-summary').click()
          await zoomPage.addStyleTag({
            content: `
            .portal-gate__layout * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
            .portal-gate__layout p { margin-block-end: 2em !important; }
          `,
          })
          const reflow = await measureReflow(
            zoomPage,
            [{ selector: '.portal-gate__layout', expectInteractive: true }],
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
  } finally {
    setPortalVisibility('public')
  }
})
