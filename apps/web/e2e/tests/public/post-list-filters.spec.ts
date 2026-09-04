import { test, expect } from '@playwright/test'

test.describe('Public Post List — chip filters', () => {
  // No retries here. 5 of this describe's tests are on e2e/known-failures.json,
  // and for a listed test a retry is dead weight: the ratchet
  // (e2e/scripts/known-failures.ts) treats `failed` and `flaky` identically for
  // a listed entry -- neither blocks, neither retires it -- so two extra
  // attempts can only downgrade the same verdict. Measured before this change
  // those retries were ~24s each and put shard 8 at 20.7m against a 6.9m
  // fastest shard. The global `retries: 2` in playwright.config.ts still
  // covers every other test. A test here that is NOT listed and fails now
  // fails loudly as NEW rather than being retried past -- that is the
  // intended trade.
  test.describe.configure({ retries: 0 })
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('shows the "Hiding completed and closed" hint by default', async ({ page }) => {
    await expect(page.getByText(/hiding completed and closed/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /show all/i })).toBeVisible()
  })

  test('Show all reveals all statuses (URL contains status param)', async ({ page }) => {
    await page.getByRole('button', { name: /show all/i }).click()
    await expect(page).toHaveURL(/[?&]status=/, { timeout: 5000 })
  })

  test('Add filter → Vote count → 5+ filters posts and adds a chip', async ({ page }) => {
    await page.getByRole('button', { name: /add filter/i }).click()
    await page.getByRole('button', { name: /^Vote count$/i }).click()
    await page.getByRole('button', { name: '5+ votes', exact: true }).click()

    await expect(page).toHaveURL(/[?&]minVotes=5/, { timeout: 5000 })
    await expect(page.getByText(/min votes:/i)).toBeVisible()
  })

  test('adding a Status chip removes the hint and updates URL', async ({ page }) => {
    await page.getByRole('button', { name: /add filter/i }).click()
    await page.getByRole('button', { name: /^Status$/i }).click()

    // Click the seeded "Open" status (default seed includes Open in the Active group).
    // If the seed changes status names, swap to whatever Active status the seed exposes.
    await page.getByRole('button', { name: /^Open$/ }).click()

    await expect(page).toHaveURL(/[?&]status=/, { timeout: 5000 })
    await expect(page.getByText(/hiding completed and closed/i)).not.toBeVisible()
  })

  test('Clear all wipes filters and the hint reappears', async ({ page }) => {
    // Apply two chips.
    await page.getByRole('button', { name: /add filter/i }).click()
    await page.getByRole('button', { name: /^Vote count$/i }).click()
    await page.getByRole('button', { name: '5+ votes', exact: true }).click()

    await page.getByRole('button', { name: /add filter/i }).click()
    await page.getByRole('button', { name: /^Created date$/i }).click()
    await page.getByRole('button', { name: /last 7 days/i }).click()

    // Clear all.
    await page.getByRole('button', { name: /clear all/i }).click()

    await expect(page).not.toHaveURL(/minVotes/)
    await expect(page).not.toHaveURL(/dateFrom/)
    await expect(page.getByText(/hiding completed and closed/i)).toBeVisible()
  })
})
