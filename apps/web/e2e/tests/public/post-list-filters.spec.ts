import { test, expect } from '@playwright/test'
import {
  selectFilterOption,
  listFilterValues,
  expectSettledPostList,
} from '../../utils/public-filter-helpers'

test.describe('Public Post List - chip filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('shows the filter entry point without active chips by default', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Active filters' })).toHaveCount(0)
    const posts = await expectSettledPostList(page)
    expect(await posts.count()).toBeGreaterThan(0)
    await expect(posts.getByText(/^(Complete|Closed)$/)).toHaveCount(0)
  })

  test('a terminal status can be explicitly included through its chip', async ({ page }) => {
    await selectFilterOption(page, 'Status', 'Closed')
    await expect.poll(() => listFilterValues(page, 'status')).toEqual(['closed'])
    await expect(
      page.getByRole('button', { name: 'Remove Status: Closed filter', exact: true })
    ).toBeVisible()
    const posts = await expectSettledPostList(page)
    expect(await posts.count()).toBeGreaterThan(0)
    for (const post of await posts.all()) {
      await expect(post.getByText('Closed', { exact: true })).toBeVisible()
    }
  })

  test('Vote count 5+ filters posts and adds a chip', async ({ page }) => {
    await selectFilterOption(page, 'Vote count', '5+ votes')
    await expect(page).toHaveURL(/[?&]minVotes=5/)
    await expect(
      page.getByRole('button', { name: 'Remove Min votes: 5+ votes filter', exact: true })
    ).toBeVisible()
    await page.waitForLoadState('networkidle')
    const counts = page.locator('[data-post-id] [data-testid="vote-count"]')
    expect(await counts.count()).toBeGreaterThan(0)
    for (const count of await counts.all()) {
      expect(Number((await count.innerText()).trim())).toBeGreaterThanOrEqual(5)
    }
  })

  test('adding another status keeps both chips and URL values', async ({ page }) => {
    await selectFilterOption(page, 'Status', 'Open')
    await page
      .getByRole('region', { name: 'Active filters' })
      .getByRole('button', { name: 'Add filter', exact: true })
      .click()
    const menu = page.locator('[data-slot="popover-content"]')
    await menu.getByRole('button', { name: 'Status', exact: true }).click()
    await menu.getByRole('option', { name: 'Planned', exact: true }).click()
    await expect.poll(() => listFilterValues(page, 'status').sort()).toEqual(['open', 'planned'])
    await expect(
      page
        .getByRole('region', { name: 'Active filters' })
        .getByRole('button', { name: /^Remove Status:/ })
    ).toHaveCount(2)
  })

  test('Clear all removes chip filters while preserving board and sort', async ({ page }) => {
    await page.goto('/?board=features&sort=new')
    await selectFilterOption(page, 'Vote count', '5+ votes')
    await selectFilterOption(page, 'Created date', 'Last 7 days')
    await expect(
      page.getByRole('button', { name: 'Remove Date: Last 7 days filter', exact: true })
    ).toBeVisible()
    await expect(page).toHaveURL(/[?&]minVotes=5/)
    await expect(page).toHaveURL(/[?&]dateFrom=/)
    await page.getByRole('button', { name: 'Clear all', exact: true }).click()
    await expect(page).not.toHaveURL(/[?&](minVotes|dateFrom)=/)
    await expect(page).toHaveURL(/[?&]board=features/)
    await expect(page).toHaveURL(/[?&]sort=new/)
    const chips = page.getByRole('region', { name: 'Active filters' })
    await expect(chips.getByRole('button', { name: /^Remove Board:/ })).toHaveCount(1)
    await expect(chips.getByRole('button', { name: /^Remove (Min votes|Date):/ })).toHaveCount(0)
  })
})
