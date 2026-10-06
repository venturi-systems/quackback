import { test, expect } from '@playwright/test'

test.describe('Portal Notifications (unauthenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies()
    await page.goto('/notifications')
    await page.waitForLoadState('networkidle')
  })

  test('requires sign-in before showing personal notifications', async ({ page }) => {
    await expect(page).toHaveURL(/\/notifications$/)
    await expect(
      page.getByRole('heading', { name: 'Sign in to view your notifications', exact: true })
    ).toBeVisible()
    await expect(page.getByText('Your notifications are tied to your account.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toHaveCount(0)
    await expect(page.getByText('All caught up!', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /mark all read|read all/i })).toHaveCount(0)

    // The page action opens authentication while retaining the personal destination.
    await page.locator('main').getByRole('button', { name: 'Log in', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').locator('input[type="email"]')).toBeVisible()
  })

  test('shows Log in and Sign up buttons on the portal header when unauthenticated', async ({
    page,
  }) => {
    // Even if we were redirected, navigate home so the header is definitely visible
    const url = page.url()
    if (!url.includes('/notifications')) {
      // Already redirected — check header on current page
    } else {
      await page.goto('/')
      await page.waitForLoadState('networkidle')
    }

    const logInButton = page.getByRole('button', { name: /log in/i })
    const signUpButton = page.getByRole('button', { name: /sign up/i })

    await expect(logInButton.first()).toBeVisible({ timeout: 10000 })
    await expect(signUpButton.first()).toBeVisible({ timeout: 10000 })
  })

  test('notification bell icon is not shown when unauthenticated', async ({ page }) => {
    // The NotificationBell component is only rendered for logged-in users
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // The bell sits next to the avatar; it should be absent for anonymous visitors
    const bell = page.locator('[aria-label*="notification" i], [data-testid*="notification-bell"]')
    await expect(bell).toHaveCount(0)
  })
})
