import { expect, type Page } from '@playwright/test'

/** Open the real category menu and require seeded options before selecting one. */
export async function openFilterCategory(page: Page, category: string) {
  // Wait for the page's initial scripts and requests before its first interaction.
  // The server-rendered trigger is visible before its click handler is attached.
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  const menu = page.locator('[data-slot="popover-content"]')
  await menu.getByRole('button', { name: category, exact: true }).click()
  await expect(menu.getByRole('option').first()).toBeVisible()
  return menu
}

export async function selectFilterOption(page: Page, category: string, name: string) {
  const menu = await openFilterCategory(page, category)
  await menu.getByRole('option', { name, exact: true }).click()
  await expect(menu).not.toBeVisible()
}

export async function selectFirstTag(page: Page) {
  const menu = await openFilterCategory(page, 'Tag')
  const option = menu.getByRole('option').first()
  const name = (await option.innerText()).trim()
  expect(name).not.toBe('')
  await option.click()
  await expect.poll(() => listFilterValues(page, 'tagIds').length).toBe(1)
  await expect(page.getByRole('region', { name: 'Active filters' })).toContainText(name)
  return name
}

/** TanStack Router serializes array search values as JSON. */
export function listFilterValues(page: Page, key: 'status' | 'tagIds'): string[] {
  const value = new URL(page.url()).searchParams.get(key)
  if (!value) return []
  const parsed: unknown = JSON.parse(value)
  expect(Array.isArray(parsed)).toBe(true)
  return parsed as string[]
}

/** A settled list must render cards or its explicit empty state, never just a URL. */
export async function expectSettledPostList(page: Page) {
  await page.waitForLoadState('networkidle')
  const results = page.locator('#portal-main div[aria-busy]')
  await expect(results).toHaveAttribute('aria-busy', 'false')
  await expect(
    page.locator('#portal-main [role="status"]').filter({
      hasText: /^\d+ posts? shown$/,
    })
  ).toBeVisible()
  await expect(results.getByRole('alert')).toHaveCount(0)
  const posts = results.locator('[data-post-id]')
  const empty = page.getByText('No posts match your filters.', { exact: true })
  await expect(posts.first().or(empty)).toBeVisible()
  await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0)
  return posts
}
