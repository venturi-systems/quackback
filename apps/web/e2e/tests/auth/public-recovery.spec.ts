import { test, expect, type BrowserContext } from '@playwright/test'
import { assertDesignFixtureEnvironment } from '../../utils/design-fixture-guard'
import { setPortalAuthMethods, setPortalVisibility } from '../../utils/access-helpers'

test.use({ storageState: { cookies: [], origins: [] } })

// FB-03: neither disabled scripting nor a failed module request may leave an
// enabled-looking sign-in control without a native route to recovery.
for (const failure of ['disabled', 'blocked'] as const) {
  test(`FB-03 public sign-in recovery with scripts ${failure}`, async ({ browser, baseURL }) => {
    await assertDesignFixtureEnvironment(baseURL)
    let context: BrowserContext | undefined
    try {
      setPortalVisibility('authenticated')
      setPortalAuthMethods('restore')
      context = await browser.newContext({
        baseURL,
        javaScriptEnabled: failure !== 'disabled',
        storageState: { cookies: [], origins: [] },
        viewport: { width: 390, height: 844 },
      })
      if (failure === 'blocked') {
        await context.route('**/*', (route) =>
          route.request().resourceType() === 'script' ? route.abort() : route.continue()
        )
      }
      const page = await context.newPage()
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      const recovery = page.locator('[data-public-sign-in-ready="false"]')
      await expect(recovery).toBeVisible()
      const help = recovery.locator('[data-public-sign-in-help]')
      await expect(help.locator('summary')).toHaveAccessibleName('Sign-in needs JavaScript')
      await help.locator('summary').click()
      await expect(
        help.getByText('If sign-in does not open, enable JavaScript and reload this page.')
      ).toBeVisible()
      const controls = recovery.locator('button, input')
      expect(await controls.count()).toBeGreaterThan(0)
      for (const control of await controls.all()) await expect(control).toBeDisabled()
      await expect(recovery.getByRole('link', { name: 'Venturi home' })).toHaveAttribute(
        'href',
        'https://venturi.systems/'
      )
      const originalUrl = page.url()
      await recovery.getByRole('link', { name: 'Reload this page' }).click()
      await expect(page).toHaveURL(originalUrl)
      await help.locator('summary').click()
      await expect(
        help.getByText('If sign-in does not open, enable JavaScript and reload this page.')
      ).toBeVisible()
    } finally {
      await context?.close()
      setPortalVisibility('public')
    }
  })
}

test('APP-FB-01 and APP-FB-02 keep public headers opaque and notices branded', async ({
  page,
  baseURL,
}) => {
  await assertDesignFixtureEnvironment(baseURL)
  try {
    setPortalVisibility('authenticated')
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 640 })
      for (const path of ['/', '/software-notices']) {
        await page.goto(path)
        if (path === '/') {
          await expect(page.locator('[data-public-sign-in-ready="true"]')).toBeVisible()
          await page.locator('details.portal-gate__roles').evaluate((el) => {
            ;(el as HTMLDetailsElement).open = true
          })
        }
        const header = page.locator('.venturi-site-header')
        const surface = await header.evaluate((el) => {
          const css = getComputedStyle(el)
          return { background: css.backgroundColor, position: css.position }
        })
        expect(surface.background).toBe('rgb(255, 255, 255)')
        expect(surface.position).toBe('sticky')
        await page.evaluate(() => window.scrollTo(0, 300))
        await expect(header).toBeVisible()
        await expect(header).toHaveCSS('background-color', 'rgb(255, 255, 255)')
        expect(await header.evaluate((el) => el.getBoundingClientRect().top)).toBe(0)
        if (path === '/software-notices') {
          const icon = page.locator('link[rel="icon"]')
          await expect(icon).toHaveAttribute('href', '/venturi-mark.svg')
          const asset = await page.request.get('/venturi-mark.svg')
          expect(asset.status()).toBe(200)
          expect(asset.headers()['content-type']).toContain('image/svg+xml')
        }
      }
    }
  } finally {
    setPortalVisibility('public')
  }
})
