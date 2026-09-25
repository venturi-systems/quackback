import { test, expect } from '@playwright/test'
import {
  assertDesignFixtureEnvironment,
  assertDesignFixtureEnvironmentSync,
} from '../../utils/design-fixture-guard'

assertDesignFixtureEnvironmentSync()
test.use({ storageState: 'e2e/.auth/admin.json', locale: 'en-US' })

test.beforeEach(async ({ baseURL }) => {
  await assertDesignFixtureEnvironment(baseURL)
})

for (const width of [320, 1440]) {
  test(`roadmap no-match recovery preserves roadmap and sort at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/roadmap?sort=oldest')
    await expect(page.locator('#portal-main h1')).toHaveText('Roadmap')
    await expect(page).toHaveURL(/[?&]roadmap=/)
    const roadmap = new URL(page.url()).searchParams.get('roadmap')
    const searchTrigger = page.locator('#portal-main').getByRole('button', { name: 'Search', exact: true })
    expect(roadmap).toBeTruthy()

    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await page.getByRole('button', { name: 'Board', exact: true }).click()
    const boardOption = page.locator(
      '[data-slot="popover-content"] [data-slot="command-item"]'
    ).first()
    await expect(boardOption).toBeVisible()
    await boardOption.click()
    await expect(page).toHaveURL(/[?&]board=/)

    await searchTrigger.click()
    const query = 'roadmap-no-match-9826431705'
    const input = page.getByRole('textbox', { name: 'Search', exact: true })
    await input.fill(query)
    await input.press('Enter')
    await expect(page).toHaveURL(new RegExp('[?&]search=' + query))
    await expect(page.getByText(query, { exact: true })).toBeVisible()
    await expect(page.getByText('No posts match your filters.', { exact: true }).first())
      .toBeVisible()
    await expect(page.getByTestId('roadmap-result-status').first()).toContainText(': 0')
    const reset = page.getByRole('button', { name: 'Clear all', exact: true })
    await expect(reset).toHaveCount(1)
    await expect(reset).toBeVisible()
    await testInfo.attach('roadmap-filtered-empty', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })

    await reset.click()
    await expect.poll(() => {
      const search = new URL(page.url()).searchParams
      return {
        roadmap: search.get('roadmap'),
        sort: search.get('sort'),
        search: search.get('search'),
        board: search.get('board'),
        tags: search.get('tags'),
        segments: search.get('segments'),
      }
    }).toEqual({ roadmap, sort: 'oldest', search: null, board: null, tags: null, segments: null })
    await expect(searchTrigger).toBeFocused()
    await expect(page.getByText(query, { exact: true })).toHaveCount(0)
    await expect(reset).toHaveCount(0)
  })
}
