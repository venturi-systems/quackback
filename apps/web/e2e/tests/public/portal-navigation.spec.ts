import { test, expect } from '@playwright/test'

test.describe('Portal identity and exploration', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' })

  test('mobile menu becomes interactive only after hydration', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 })
    let releaseHeader!: () => void
    const headerReady = new Promise<void>((resolve) => {
      releaseHeader = resolve
    })
    let headerRequested = false
    // The CI fixture serves Vite modules. Hold the header module to exercise
    // the server-rendered control before React can attach its click handler.
    await page.route('**/src/components/public/portal-header.tsx*', async (route) => {
      headerRequested = true
      await headerReady
      await route.continue()
    })
    await page.goto('/', { waitUntil: 'commit' })
    const menu = page.getByRole('button', { name: 'Menu', exact: true })
    try {
      await expect(menu).toBeVisible()
      await expect.poll(() => headerRequested).toBe(true)
      await expect(menu).toBeDisabled()
      await expect(menu).toHaveAttribute('aria-expanded', 'false')
    } finally {
      releaseHeader()
    }
    await expect(menu).toBeEnabled()
    await menu.click()
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    const navigation = page.getByRole('navigation', {
      name: 'Mobile portal navigation',
      exact: true,
    })
    await expect(navigation.getByRole('link', { name: 'Feedback', exact: true })).toHaveCount(1)
    await navigation.getByRole('link', { name: 'Roadmap', exact: true }).click()
    await expect(page).toHaveURL(/\/roadmap/)
  })
  for (const width of [320, 1440]) {
    test(`clear product destinations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const brand = page.getByRole('link', { name: 'Venturi Feedback home', exact: true })
      await expect(brand).toHaveAttribute('href', '/')
      await expect(page.getByRole('heading', { name: 'Product ideas', exact: true })).toBeVisible()
      await expect(page.locator('.venturi-brand__product')).toHaveCount(0)
      await expect(
        page.getByRole('link', { name: 'Software notices', exact: true })
      ).toHaveAttribute('href', '/software-notices')
      await expect(page.getByRole('link', { name: /Source code/ })).toHaveCount(0)
      if (width >= 1024) {
        await expect(
          page.getByRole('link', { name: 'About Venturi', exact: true })
        ).toHaveAttribute('href', /^https:\/\/venturi\.systems\//)
      }
      const menu = page.getByRole('button', { name: 'Menu', exact: true })
      if (width < 640) {
        await expect(menu).toBeEnabled()
        await menu.click()
      }
      const navigation = page.getByRole('navigation', {
        name: width < 640 ? 'Mobile portal navigation' : 'Portal navigation',
        exact: true,
      })
      await expect(navigation.getByRole('link', { name: 'Feedback', exact: true })).toHaveCount(1)
      await navigation.getByRole('link', { name: 'Roadmap', exact: true }).click()
      await expect(page).toHaveURL(/\/roadmap/)
      await brand.click()
      await expect(page).toHaveURL(
        (url) => url.pathname === '/' && url.searchParams.get('sort') === 'trending'
      )
      if (width < 640) {
        await expect(menu).toBeEnabled()
        await menu.click()
      }
      await navigation.getByRole('link', { name: 'Changelog', exact: true }).click()
      await expect(page).toHaveURL(/\/changelog/)
    })
  }
})

test.use({ storageState: { cookies: [], origins: [] } })

test('software notices and exact-build source are available without sign-in', async ({ page }) => {
  await page.goto('/software-notices')
  await expect(page).toHaveURL(/\/software-notices$/)
  await expect(page.getByRole('heading', { name: 'Software notices' })).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'View the source for this version' })
  ).toHaveAttribute(
    'href',
    /https:\/\/github\.com\/venturi-systems\/quackback(?:\/tree\/[0-9a-f]{7,40})?$/
  )
})
