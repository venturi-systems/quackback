import { test, expect, type BrowserContext } from '@playwright/test'
import { assertDesignFixtureEnvironment } from '../utils/design-fixture-guard'
import { setPortalAuthMethods, setPortalVisibility } from '../utils/access-helpers'

// This project runs after the keyboard walks; fixture visibility is shared.
test.describe.configure({ mode: 'serial' })
test.use({ storageState: { cookies: [], origins: [] } })

// FB-R21-READINESS-SHIFT-01: server-rendered help must survive hydration without
// moving the form or losing an already-open native disclosure and its focus.
for (const { width, textScale } of [
  { width: 320, textScale: 1 },
  { width: 390, textScale: 1 },
  { width: 1440, textScale: 1 },
  { width: 320, textScale: 2 },
]) {
  for (const expanded of [false, true]) {
    test(`FB-R21 stable readiness at ${width}px, text ${textScale}x, help ${expanded ? 'open' : 'closed'}`, async ({
      browser,
      baseURL,
    }) => {
      await assertDesignFixtureEnvironment(baseURL)
      let context: BrowserContext | undefined
      let releaseScripts = () => {}
      const scriptsReady = new Promise<void>((resolve) => {
        releaseScripts = resolve
      })
      try {
        setPortalVisibility('authenticated')
        setPortalAuthMethods('restore')
        context = await browser.newContext({
          baseURL,
          storageState: { cookies: [], origins: [] },
          viewport: { width, height: 844 },
        })
        await context.route('**/*', async (route) => {
          if (route.request().resourceType() === 'script') await scriptsReady
          await route.continue()
        })
        const page = await context.newPage()
        const pageErrors: string[] = []
        page.on('pageerror', (error) => pageErrors.push(error.message))
        await page.goto('/', { waitUntil: 'commit' })
        const readiness = page.locator('[data-public-sign-in-ready]')
        await expect(readiness).toHaveAttribute('data-public-sign-in-ready', 'false')
        const help = readiness.locator('[data-public-sign-in-help]')
        const summary = help.locator('summary')
        await expect(summary).toHaveAccessibleName('Sign-in needs JavaScript')
        if (textScale === 2) {
          await page.addStyleTag({
            content:
              '[data-public-sign-in-help] { font-size: 32px !important; line-height: 1.5 !important; }',
          })
        }
        await expect(help).toHaveCSS('font-size', textScale === 2 ? '32px' : '16px')
        await page.evaluate(async () => {
          await document.fonts.load('16px "DM Sans"')
          await document.fonts.ready
        })
        await summary.focus()
        if (expanded) await page.keyboard.press('Space')
        await expect(help).toHaveJSProperty('open', expanded)
        const geometry = () =>
          page
            .locator(
              '.public-frame__main, .venturi-footer, [data-public-sign-in-help], [data-public-sign-in-help] summary, [data-public-sign-in-ready] fieldset'
            )
            .evaluateAll((elements) =>
              elements.map((element) => {
                const box = element.getBoundingClientRect()
                return { x: box.x, y: box.y, width: box.width, height: box.height }
              })
            )
        const before = await geometry()
        expect(before.length).toBe(5)
        const controls = readiness.locator('fieldset button, fieldset input')
        const ownDisabled = await controls.evaluateAll((elements) =>
          elements.map((element) => (element as HTMLInputElement | HTMLButtonElement).disabled)
        )
        expect(ownDisabled.some((disabled) => !disabled)).toBe(true)
        for (const control of await controls.all()) {
          await expect(control).toBeDisabled()
        }
        releaseScripts()
        await expect(readiness).toHaveAttribute('data-public-sign-in-ready', 'true')
        await expect(summary).toHaveAccessibleName('Sign-in help')
        await expect(summary).toBeFocused()
        await expect(help).toHaveJSProperty('open', expanded)
        const after = await geometry()
        expect(after.length).toBe(before.length)
        for (let index = 0; index < before.length; index++) {
          for (const dimension of ['x', 'y', 'width', 'height'] as const) {
            expect(Math.abs(after[index][dimension] - before[index][dimension])).toBeLessThan(0.5)
          }
        }
        await expect(readiness.locator('fieldset')).toHaveJSProperty('disabled', false)
        // Readiness must not override a control's own validation/busy state.
        for (const [index, control] of (await controls.all()).entries()) {
          await expect(control).toHaveJSProperty('disabled', ownDisabled[index])
          if (ownDisabled[index]) await expect(control).toBeDisabled()
          else await expect(control).toBeEnabled()
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        )
        if (!expanded) await page.keyboard.press('Space')
        await expect(help.getByRole('link', { name: 'Reload this page' })).toBeVisible()
        await expect(help.getByRole('link', { name: 'Venturi home' })).toBeVisible()
        expect(pageErrors).toEqual([])
      } finally {
        releaseScripts()
        await context?.unrouteAll({ behavior: 'wait' })
        await context?.close()
        setPortalVisibility('public')
      }
    })
  }
}
