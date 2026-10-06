import { test, expect, type Route } from '@playwright/test'

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
      await expect(page).toHaveURL((url) => url.pathname === '/' && !url.searchParams.has('sort'))
      // The home page itself, not only its address. A roadmap still settling
      // used to replace this navigation with itself (venturi-systems/feedback#369).
      await expect(page.getByRole('heading', { name: 'Product ideas', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toHaveCount(0)
      if (width < 640) {
        await expect(menu).toBeEnabled()
        await menu.click()
      }
      await navigation.getByRole('link', { name: 'Changelog', exact: true }).click()
      await expect(page).toHaveURL(/\/changelog/)
    })
  }
  test('a roadmap still settling does not replace the way home', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 })
    await page.goto('/')
    const menu = page.getByRole('button', { name: 'Menu', exact: true })
    await expect(menu).toBeEnabled()
    // Every client navigation calls the root route's bootstrap server function
    // before it commits. Let the Roadmap navigation's call through, then hold
    // the rest: the roadmap's own address update and the way home both stay
    // pending while the board is mounted. The dev server names a server
    // function's export in base64url JSON in its URL.
    const held: Route[] = []
    let bootstrapCalls = 0
    let holding = true
    await page.route('**/_serverFn/**', async (route) => {
      const id = new URL(route.request().url()).pathname.split('/_serverFn/')[1] ?? ''
      const name = Buffer.from(decodeURIComponent(id), 'base64url').toString('utf8')
      if (holding && name.includes('getBootstrapData') && ++bootstrapCalls > 1) {
        held.push(route)
        return
      }
      await route.continue()
    })
    await menu.click()
    const navigation = page.getByRole('navigation', {
      name: 'Mobile portal navigation',
      exact: true,
    })
    await navigation.getByRole('link', { name: 'Roadmap', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible()
    // The board writes its default roadmap into the address once settled.
    await expect(page).toHaveURL(/[?&]roadmap=roadmap_/)
    await expect.poll(() => held.length).toBeGreaterThan(0)
    const heldBeforeHome = held.length
    await page.getByRole('link', { name: 'Venturi Feedback home', exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === '/')
    await expect.poll(() => held.length).toBeGreaterThan(heldBeforeHome)
    // Re-render the board while Home is pending, as a settling query or a
    // scroll does. Its columns overflow at 320px.
    await page.getByRole('button', { name: 'Scroll columns right', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Scroll columns left', exact: true })
    ).toBeVisible()
    holding = false
    for (const route of held.splice(0)) await route.continue()
    await expect(page.getByRole('heading', { name: 'Product ideas', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toHaveCount(0)
    await expect(page).toHaveURL((url) => url.pathname === '/' && !url.searchParams.has('roadmap'))
  })
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
