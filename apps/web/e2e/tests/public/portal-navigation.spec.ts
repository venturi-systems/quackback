import { test, expect } from '@playwright/test'

test.describe('Portal identity and exploration', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' })

  for (const width of [320, 1440]) {
    test(`clear product destinations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const brand = page.locator('.venturi-brand__product')
      await expect(brand).toHaveAttribute('href', '/')
      await expect(page.getByRole('heading', { name: 'Feedback', exact: true })).toBeVisible()
      if (width < 640) await page.getByRole('button', { name: 'Menu', exact: true }).click()
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
      if (width < 640) await page.getByRole('button', { name: 'Menu', exact: true }).click()
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
