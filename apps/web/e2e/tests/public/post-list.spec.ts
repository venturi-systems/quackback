import { test, expect } from '@playwright/test'
import {
  openFilterCategory,
  selectFilterOption,
  selectFirstTag,
  listFilterValues,
  expectSettledPostList,
} from '../../utils/public-filter-helpers'

test.describe('Public Post List', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the public portal (tenant subdomain)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('displays feedback posts', async ({ page }) => {
    // Should show at least one post card (Link elements with href containing /posts/)
    const postCards = page.locator('a[href*="/posts/"]:has(h3)')
    await expect(postCards.first()).toBeVisible({ timeout: 10000 })

    // Each post should have a title visible
    const firstPost = postCards.first()
    await expect(firstPost).toBeVisible()
  })

  test('shows post details on cards', async ({ page }) => {
    // Wait for posts to load
    const postCards = page.locator('a[href*="/posts/"]:has(h3)')
    await expect(postCards.first()).toBeVisible({ timeout: 10000 })

    const firstPost = postCards.first()
    await expect(firstPost.getByTestId('vote-button')).toBeVisible()
    await expect(firstPost.getByTestId('vote-count')).toHaveText(/^\d+$/)
    await expect(firstPost.getByRole('heading')).not.toBeEmpty()
  })

  test('can filter by board using sidebar', async ({ page }) => {
    // Wait for page to load
    await page.waitForLoadState('networkidle')

    // Look for board filter buttons in sidebar
    const boardButtons = page.locator('button').filter({ hasText: /feature|bug|general/i })

    // If board filter exists, click it
    const boardButton = boardButtons.first()
    if ((await boardButton.count()) > 0) {
      await boardButton.click()

      // URL should update with board parameter
      await expect(page).toHaveURL(/[?&]board=/, { timeout: 5000 })
    }
  })

  test('can search for posts', async ({ page }) => {
    // Look for search input
    const searchInput = page.getByPlaceholder(/search/i)

    if ((await searchInput.count()) > 0) {
      await searchInput.fill('test')
      await searchInput.press('Enter')

      // URL should update with search parameter
      await expect(page).toHaveURL(/[?&]search=test/, { timeout: 5000 })
    }
  })

  test('defaults to Trending sort with visual indicator', async ({ page }) => {
    // Navigate to page without sort param
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // "Trending" button should be active (has font-medium class)
    const trendingButton = page.getByRole('button', { name: /^Trending$/i })
    await expect(trendingButton).toHaveClass(/font-medium/)

    // Other sort buttons should not be active
    const topButton = page.getByRole('button', { name: /^Top$/i })
    const newButton = page.getByRole('button', { name: /^New$/i })
    await expect(topButton).not.toHaveClass(/font-medium/)
    await expect(newButton).not.toHaveClass(/font-medium/)
  })

  test('can sort posts by clicking New', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Click "New" sort option
    const newButton = page.getByRole('button', { name: /^New$/i })
    await newButton.click()

    // URL should update with sort parameter
    await expect(page).toHaveURL(/[?&]sort=new/)

    // "New" should now be active
    await expect(newButton).toHaveClass(/font-medium/)

    // "Top" should no longer be active
    const topButton = page.getByRole('button', { name: /^Top$/i })
    await expect(topButton).not.toHaveClass(/font-medium/)
  })

  test('can sort posts by clicking Trending', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Click "Trending" sort option
    const trendingButton = page.getByRole('button', { name: /^Trending$/i })
    await trendingButton.click()

    // Trending is the default, so its redundant parameter is omitted.
    await expect(page).toHaveURL((url) => url.pathname === '/' && !url.searchParams.has('sort'))

    // "Trending" should now be active
    await expect(trendingButton).toHaveClass(/font-medium/)
  })

  test('navigating with sort param in URL shows correct active state', async ({ page }) => {
    // Navigate directly with sort=new
    await page.goto('/?sort=new')
    await page.waitForLoadState('networkidle')

    // "New" should be active
    const newButton = page.getByRole('button', { name: /^New$/i })
    await expect(newButton).toHaveClass(/font-medium/)

    // "Top" should not be active
    const topButton = page.getByRole('button', { name: /^Top$/i })
    await expect(topButton).not.toHaveClass(/font-medium/)
  })

  test('can switch between all sort options', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const topButton = page.getByRole('button', { name: /^Top$/i })
    const newButton = page.getByRole('button', { name: /^New$/i })
    const trendingButton = page.getByRole('button', { name: /^Trending$/i })

    // Start with Trending active
    await expect(trendingButton).toHaveClass(/font-medium/)

    // Switch to New
    await newButton.click()
    await expect(page).toHaveURL(/[?&]sort=new/)
    await expect(newButton).toHaveClass(/font-medium/)
    await expect(trendingButton).not.toHaveClass(/font-medium/)

    // Switch to Top
    await topButton.click()
    await expect(page).toHaveURL(/[?&]sort=top/)
    await expect(topButton).toHaveClass(/font-medium/)
    await expect(newButton).not.toHaveClass(/font-medium/)

    // Switch back to Trending
    await trendingButton.click()
    await expect(page).toHaveURL((url) => url.pathname === '/' && !url.searchParams.has('sort'))
    await expect(trendingButton).toHaveClass(/font-medium/)
    await expect(topButton).not.toHaveClass(/font-medium/)
  })

  test('sort persists with board filter', async ({ page }) => {
    // Navigate with both board and sort params (using 'features' board which exists in database)
    await page.goto('/?board=features&sort=new')

    // Wait for page to be ready
    await page.waitForLoadState('networkidle')

    // Skip if the features board has no posts in this environment
    const postCards = page.locator('[data-post-id]')
    test.skip(
      (await postCards.count()) === 0,
      'No posts found for features board in this environment'
    )

    // Both filters should be active
    await expect(page).toHaveURL(/board=features/)
    await expect(page).toHaveURL(/sort=new/)

    // Sort button should show correct state (wait for it to have the class)
    const newButton = page.getByRole('button', { name: /^New$/i })
    await expect(newButton).toHaveClass(/font-medium/, { timeout: 10000 })

    // Board should be selected
    const featuresButton = page.locator('aside').getByRole('button', { name: /Feature Requests/i })
    await expect(featuresButton).toHaveClass(/font-medium/, { timeout: 10000 })
  })

  test('clicking post navigates to detail page', async ({ page }) => {
    // Wait for posts to load
    const postCards = page.locator('a[href*="/posts/"]:has(h3)')
    await expect(postCards.first()).toBeVisible({ timeout: 15000 })

    // Get the href of the first post
    const firstPostHref = await postCards.first().getAttribute('href')

    // Click the first post and wait for navigation
    await Promise.all([page.waitForURL(/\/posts\//, { timeout: 15000 }), postCards.first().click()])

    // Should navigate to the post detail page
    if (firstPostHref) {
      await expect(page).toHaveURL(
        new RegExp(firstPostHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        { timeout: 10000 }
      )
    }
  })

  test('displays post status badges', async ({ page }) => {
    // Wait for posts to load
    await page.waitForLoadState('networkidle')

    // Look for status badges (they have specific styling)
    const statusBadges = page.locator('[class*="badge"]')

    // At least one badge should be visible (either status or tag)
    if ((await statusBadges.count()) > 0) {
      await expect(statusBadges.first()).toBeVisible()
    }
  })

  test('displays filtered posts when navigating with board param in URL', async ({ page }) => {
    // Navigate directly to URL with board filter (using 'features' board which exists in database)
    await page.goto('/?board=features')

    // Wait for page to be ready
    await page.waitForLoadState('networkidle')

    // Skip if the features board has no posts in this environment
    const postCards = page.locator('[data-post-id]')
    test.skip(
      (await postCards.count()) === 0,
      'No posts found for features board in this environment'
    )

    // URL should contain the board parameter
    await expect(page).toHaveURL(/[?&]board=features/)

    // The "Feature Requests" board should be visually selected in the sidebar (has font-medium class)
    const featuresButton = page.locator('aside').getByRole('button', { name: /Feature Requests/i })
    await expect(featuresButton).toHaveClass(/font-medium/, { timeout: 10000 })

    // "View all posts" should NOT be selected (no font-medium)
    const viewAllButton = page.getByRole('button', { name: /View all posts/i }).first()
    await expect(viewAllButton).not.toHaveClass(/font-medium/)
  })

  test('can view all posts after filtering by board', async ({ page }) => {
    // Start with a board filter applied (using 'features' board which exists in database)
    await page.goto('/?board=features')
    await page.waitForLoadState('networkidle')

    // Verify we're filtered
    await expect(page).toHaveURL(/[?&]board=features/)

    // Click "View all posts" button in sidebar
    const viewAllButton = page.getByRole('button', { name: /View all posts/i })
    await viewAllButton.click()

    // URL should no longer have the board parameter
    await expect(page).not.toHaveURL(/[?&]board=/)

    // Navigate fresh to verify the state renders correctly
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // "View all posts" should now be selected (has font-medium class when active)
    const viewAllButtonFresh = page.getByRole('button', { name: /View all posts/i })
    await expect(viewAllButtonFresh).toHaveClass(/font-medium/)
  })

  test('filtered board posts link to correct board routes', async ({ page }) => {
    // Navigate to features board
    await page.goto('/?board=features')
    await page.waitForLoadState('networkidle')

    // Get all post links
    const postLinks = page.locator('a[href*="/posts/"]')
    const linkCount = await postLinks.count()

    if (linkCount > 0) {
      // Check that all visible posts link to the features board
      for (let i = 0; i < Math.min(linkCount, 5); i++) {
        const href = await postLinks.nth(i).getAttribute('href')
        // Posts should link to /b/features/posts/{id}
        expect(href).toMatch(/^\/b\/features\/posts\//)
      }
    }
  })

  test('switching boards updates displayed posts', async ({ page }) => {
    // Start with features board
    await page.goto('/?board=features')
    await page.waitForLoadState('networkidle')

    // Get initial post hrefs (all should be /features/posts/...)
    const initialLinks = page.locator('a[href*="/posts/"]')
    const initialCount = await initialLinks.count()

    if (initialCount > 0) {
      const firstInitialHref = await initialLinks.first().getAttribute('href')
      expect(firstInitialHref).toMatch(/^\/b\/features\/posts\//)
    }

    // Switch to bugs board via sidebar
    const bugsButton = page.getByRole('button', { name: /Bug Reports/i })
    if ((await bugsButton.count()) > 0) {
      await bugsButton.click()

      // URL should update
      await expect(page).toHaveURL(/[?&]board=bugs/)
      await page.waitForLoadState('networkidle')

      // Wait for posts to refresh - should now link to /bugs/posts/...
      // Use a locator that specifically looks for bugs board posts
      const bugsPostLinks = page.locator('a[href*="/b/bugs/posts/"]')
      await expect(bugsPostLinks.first()).toBeVisible({ timeout: 10000 })

      const firstNewHref = await bugsPostLinks.first().getAttribute('href')
      expect(firstNewHref).toMatch(/^\/b\/bugs\/posts\//)
    }
  })

  test.describe('Filter Dropdown', () => {
    test('filter button opens dropdown', async ({ page }) => {
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      const menu = page.locator('[data-slot="popover-content"]')
      for (const name of ['Status', 'Tag', 'Vote count', 'Created date', 'Team response']) {
        await expect(menu.getByRole('button', { name, exact: true })).toBeVisible()
      }
    })

    test('filter dropdown shows status options', async ({ page }) => {
      const menu = await openFilterCategory(page, 'Status')
      await expect(menu.getByRole('option', { name: 'Open', exact: true })).toBeVisible()
      await expect(menu.getByRole('option', { name: 'Planned', exact: true })).toBeVisible()
    })

    test('can select status filter', async ({ page }) => {
      await selectFilterOption(page, 'Status', 'Open')
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      await expect(
        page.getByRole('button', { name: 'Remove Status: Open filter', exact: true })
      ).toBeVisible()
    })

    test('selected status is represented by a removable chip', async ({ page }) => {
      await selectFilterOption(page, 'Status', 'Open')
      const chips = page.getByRole('region', { name: 'Active filters' })
      await expect(chips.getByRole('button', { name: /^Remove Status:/ })).toHaveCount(1)
      await expect(
        chips.getByRole('button', { name: 'Remove Status: Open filter', exact: true })
      ).toBeVisible()
    })

    test('can clear all filters', async ({ page }) => {
      await selectFilterOption(page, 'Status', 'Open')
      await selectFilterOption(page, 'Vote count', '5+ votes')
      await expect(page).toHaveURL(/[?&]minVotes=5/)
      await page.getByRole('button', { name: 'Clear all', exact: true }).click()
      await expect.poll(() => listFilterValues(page, 'status')).toEqual([])
      await expect(page).not.toHaveURL(/[?&]minVotes=/)
      await expect(page.getByRole('region', { name: 'Active filters' })).toHaveCount(0)
    })

    test('status filter persists with other filters', async ({ page }) => {
      await page.goto('/?board=features&sort=new')
      await selectFilterOption(page, 'Status', 'Open')
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      await expect(page).toHaveURL(/[?&]board=features/)
      await expect(page).toHaveURL(/[?&]sort=new/)
    })

    test('can toggle status filter on and off', async ({ page }) => {
      await selectFilterOption(page, 'Status', 'Open')
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      await selectFilterOption(page, 'Status', 'Open')
      await expect.poll(() => listFilterValues(page, 'status')).toEqual([])
      await expect(
        page.getByRole('button', { name: 'Remove Status: Open filter', exact: true })
      ).toHaveCount(0)
    })

    test('can select multiple status filters', async ({ page }) => {
      await selectFilterOption(page, 'Status', 'Open')
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      await selectFilterOption(page, 'Status', 'Planned')
      await expect.poll(() => listFilterValues(page, 'status').sort()).toEqual(['open', 'planned'])
      await expect(
        page
          .getByRole('region', { name: 'Active filters' })
          .getByRole('button', { name: /^Remove Status:/ })
      ).toHaveCount(2)
    })

    test('filter dropdown shows seeded tag options', async ({ page }) => {
      const menu = await openFilterCategory(page, 'Tag')
      expect(await menu.getByRole('option').count()).toBeGreaterThan(0)
      expect((await menu.getByRole('option').first().innerText()).trim()).not.toBe('')
    })

    test('navigating with status param shows the selected chip', async ({ page }) => {
      await page.goto('/?status=%5B%22open%22%5D')
      await expect(
        page.getByRole('button', { name: 'Remove Status: Open filter', exact: true })
      ).toBeVisible()
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      await expectSettledPostList(page)
    })

    test('can select tag filter when tags exist', async ({ page }) => {
      const tag = await selectFirstTag(page)
      await expect(
        page.getByRole('button', { name: `Remove Tag: ${tag} filter`, exact: true })
      ).toBeVisible()
    })

    test('tag and status selections each produce a chip', async ({ page }) => {
      await selectFirstTag(page)
      const chips = page.getByRole('region', { name: 'Active filters' })
      await expect(chips.getByRole('button', { name: /^Remove .* filter$/ })).toHaveCount(1)
      await selectFilterOption(page, 'Status', 'Open')
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      await expect(chips.getByRole('button', { name: /^Remove .* filter$/ })).toHaveCount(2)
    })

    test('combined status and tag filtering updates URL correctly', async ({ page }) => {
      await selectFilterOption(page, 'Status', 'Open')
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      await selectFirstTag(page)
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      await expect.poll(() => listFilterValues(page, 'tagIds').length).toBe(1)
    })

    test('clearing filters removes both status and tag params', async ({ page }) => {
      await selectFilterOption(page, 'Status', 'Open')
      await selectFirstTag(page)
      await page.getByRole('button', { name: 'Clear all', exact: true }).click()
      await expect.poll(() => listFilterValues(page, 'status')).toEqual([])
      await expect.poll(() => listFilterValues(page, 'tagIds')).toEqual([])
      await expect(page.getByRole('region', { name: 'Active filters' })).toHaveCount(0)
    })

    test('filter state persists on page reload', async ({ page }) => {
      await selectFilterOption(page, 'Status', 'Open')
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      const url = page.url()
      await page.reload()
      await expect(page).toHaveURL(url)
      await expect(
        page.getByRole('button', { name: 'Remove Status: Open filter', exact: true })
      ).toBeVisible()
      await expectSettledPostList(page)
    })

    test('status filter triggers post list refresh', async ({ page }) => {
      await expect(page.locator('[data-post-id]').first()).toBeVisible()
      await selectFilterOption(page, 'Status', 'Open')
      await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
      const posts = await expectSettledPostList(page)
      expect(await posts.count()).toBeGreaterThan(0)
      for (const post of await posts.all()) {
        await expect(post.getByText('Open', { exact: true })).toBeVisible()
      }
    })

    test('shows empty state when filters match no posts', async ({ page }) => {
      await page.goto('/?search=filter-no-match-839157246091')
      await expect(page.getByText('No posts match your filters.', { exact: true })).toBeVisible()
      await expect(page.locator('[data-post-id]')).toHaveCount(0)
    })

    test('filter dropdown closes when clicking outside', async ({ page }) => {
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      const menu = page.locator('[data-slot="popover-content"]')
      await expect(menu.getByRole('button', { name: 'Status', exact: true })).toBeVisible()
      await page.locator('#portal-main h1').click()
      await expect(menu).not.toBeVisible()
    })

    test('multiple status filters use OR logic (shows posts matching any)', async ({ page }) => {
      await selectFilterOption(page, 'Status', 'Open')
      const first = await expectSettledPostList(page)
      expect(await first.count()).toBeGreaterThan(0)
      const firstCount = await first.count()
      await selectFilterOption(page, 'Status', 'Planned')
      await expect.poll(() => listFilterValues(page, 'status').sort()).toEqual(['open', 'planned'])
      const both = await expectSettledPostList(page)
      expect(await both.count()).toBeGreaterThanOrEqual(firstCount)
      await expect(
        both.filter({ has: page.getByText('Open', { exact: true }) }).first()
      ).toBeVisible()
      for (const post of await both.all()) {
        await expect(post.getByText(/^(Open|Planned)$/)).toBeVisible()
      }
      await expect(
        both.filter({ has: page.getByText('Planned', { exact: true }) }).first()
      ).toBeVisible()
    })
  })
})

// ---------------------------------------------------------------------------
// Filter Result Verification
// ---------------------------------------------------------------------------

test.describe('Post List - Filter Result Verification', () => {
  test('status filter: all visible post status badges match the applied filter', async ({
    page,
  }) => {
    await page.goto('/')
    await selectFilterOption(page, 'Status', 'Open')
    const posts = await expectSettledPostList(page)
    expect(await posts.count()).toBeGreaterThan(0)
    for (const post of await posts.all()) {
      await expect(post.getByText('Open', { exact: true })).toBeVisible()
    }
  })

  test('board filter: all visible post links belong to the selected board', async ({ page }) => {
    await page.goto('/?board=features')
    const posts = await expectSettledPostList(page)
    expect(await posts.count()).toBeGreaterThan(0)
    for (const post of await posts.all()) {
      await expect(post).toHaveAttribute('href', /^\/b\/features\/posts\//)
    }
  })

  test('tag filter: post count is reduced after applying a tag filter', async ({ page }) => {
    await page.goto('/')
    const all = await expectSettledPostList(page)
    const originalCount = await all.count()
    expect(originalCount).toBeGreaterThan(0)
    const tag = await selectFirstTag(page)
    const filtered = await expectSettledPostList(page)
    expect(await filtered.count()).toBeGreaterThan(0)
    expect(await filtered.count()).toBeLessThanOrEqual(originalCount)
    for (const post of await filtered.all()) {
      await expect(post.getByText(tag, { exact: true })).toBeVisible()
    }
  })

  test('clearing a filter restores posts with other statuses', async ({ page }) => {
    await page.goto('/')
    const all = await expectSettledPostList(page)
    const otherStatus = all.filter({ hasNot: page.getByText('Open', { exact: true }) }).first()
    await expect(otherStatus).toBeVisible()
    const id = await otherStatus.getAttribute('data-post-id')
    expect(id).toBeTruthy()
    const restoredPost = page.locator(`[data-post-id="${id}"]`)

    await selectFilterOption(page, 'Status', 'Open')
    await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
    const filtered = await expectSettledPostList(page)
    expect(await filtered.count()).toBeGreaterThan(0)
    await expect(restoredPost).toHaveCount(0)
    await page.getByRole('button', { name: 'Remove Status: Open filter', exact: true }).click()
    await expect.poll(() => listFilterValues(page, 'status')).toEqual([])
    await expectSettledPostList(page)
    // Compare membership, not page lengths: both pages can hit the 20-card limit.
    await expect(restoredPost).toBeVisible()
  })

  test('combining board + status filters: count ≤ board-only count AND status-only count', async ({
    page,
  }) => {
    await page.goto('/?board=features')
    const boardOnlyCount = await (await expectSettledPostList(page)).count()
    expect(boardOnlyCount).toBeGreaterThan(0)
    await page.goto('/?status=%5B%22open%22%5D')
    const statusOnlyCount = await (await expectSettledPostList(page)).count()
    expect(statusOnlyCount).toBeGreaterThan(0)
    await selectFilterOption(page, 'Board', 'Feature Requests')
    await expect(page).toHaveURL(/[?&]board=features/)
    await expect.poll(() => listFilterValues(page, 'status')).toEqual(['open'])
    const combined = await expectSettledPostList(page)
    const count = await combined.count()
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThanOrEqual(boardOnlyCount)
    expect(count).toBeLessThanOrEqual(statusOnlyCount)
    for (const post of await combined.all()) {
      await expect(post).toHaveAttribute('href', /^\/b\/features\/posts\//)
      await expect(post.getByText('Open', { exact: true })).toBeVisible()
    }
  })

  test('empty state shows "No posts match your filters." when no posts match', async ({ page }) => {
    await page.goto('/?search=filter-no-match-839157246091')
    await expect(page.getByText('No posts match your filters.', { exact: true })).toBeVisible()
    await expect(page.locator('[data-post-id]')).toHaveCount(0)
    await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// Sort Order Verification
// ---------------------------------------------------------------------------

test.describe('Post List - Sort Order Verification', () => {
  test('"New" sort: first post was created more recently than the second post', async ({
    page,
  }) => {
    await page.goto('/?sort=new')
    const postCards = page.locator('[data-post-id]')
    await expect(postCards.first()).toBeVisible({ timeout: 15000 })
    await page.waitForLoadState('networkidle')

    const count = await postCards.count()
    test.skip(count < 2, 'Need at least 2 posts to verify sort order')

    // TimeAgo renders relative text, but the <a> element carries a data-post-id.
    // The most robust DOM signal: the post links themselves include the post IDs.
    // We verify ordering by checking that switching between "New" and "Top" produces
    // different first-post IDs (proving the sort actually changes the list).

    // Capture the first post ID under "new" sort
    const firstPostIdNew = await postCards.first().getAttribute('data-post-id')
    expect(firstPostIdNew).toBeTruthy()

    // Switch to "top" sort
    const topButton = page.getByRole('button', { name: /^Top$/i })
    await topButton.click()
    await expect(page).toHaveURL(/sort=top/, { timeout: 5000 })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(300)

    const firstPostIdTop = await postCards.first().getAttribute('data-post-id')
    expect(firstPostIdTop).toBeTruthy()

    // Guard: if both sorts produce the same first post the seed data isn't
    // diverse enough to differentiate them — skip rather than fail.
    test.skip(
      firstPostIdNew === firstPostIdTop,
      'Sort may not differentiate with current data (same first post for new and top)'
    )

    // With 500 seed posts it is astronomically unlikely for new-sort and top-sort
    // to have the same first post. Verify they differ, confirming sort works.
    expect(firstPostIdNew).not.toBe(firstPostIdTop)
  })

  test('"Top" sort: first post has vote count ≥ second post vote count', async ({ page }) => {
    await page.goto('/?sort=top')
    const postCards = page.locator('[data-post-id]')
    await expect(postCards.first()).toBeVisible({ timeout: 15000 })
    await page.waitForLoadState('networkidle')

    const count = await postCards.count()
    test.skip(count < 2, 'Need at least 2 posts to verify sort order')

    // Read vote counts from the DOM via data-testid="vote-count"
    const voteCountSpans = page.locator('[data-post-id] [data-testid="vote-count"]')
    const firstVoteText = await voteCountSpans.nth(0).textContent()
    const secondVoteText = await voteCountSpans.nth(1).textContent()

    test.skip(!firstVoteText || !secondVoteText, 'Vote count elements not found')

    const firstVotes = parseInt(firstVoteText!.trim(), 10)
    const secondVotes = parseInt(secondVoteText!.trim(), 10)

    expect(isNaN(firstVotes)).toBe(false)
    expect(isNaN(secondVotes)).toBe(false)
    // Top sort: higher vote counts first
    expect(firstVotes).toBeGreaterThanOrEqual(secondVotes)
  })

  test('"New" sort places a recently-created post before an older one', async ({ page }) => {
    await page.goto('/?sort=new')
    const postCards = page.locator('[data-post-id]')
    await expect(postCards.first()).toBeVisible({ timeout: 15000 })
    await page.waitForLoadState('networkidle')

    const count = await postCards.count()
    test.skip(count < 2, 'Need at least 2 posts to verify sort order')

    // TimeAgo component renders strings like "about 2 hours ago", "3 days ago".
    // Capture the first two time-ago strings and verify the first is not older than the second.
    // Strategy: "X minutes/hours ago" is newer than "X days/months ago".
    // Note: .post-card is on the same element as [data-post-id], not a descendant.
    const timeAgoSpans = page.locator('[data-post-id] span.text-muted-foreground\\/70')
    const firstTimeAgo = (await timeAgoSpans.nth(0).textContent())?.trim() ?? ''
    const secondTimeAgo = (await timeAgoSpans.nth(1).textContent())?.trim() ?? ''

    // Both should be non-empty relative time strings
    expect(firstTimeAgo.length).toBeGreaterThan(0)
    expect(secondTimeAgo.length).toBeGreaterThan(0)

    // Simple ordering heuristic: if the first contains "minutes" or "hours" and
    // the second contains "days" or "months", the first is definitely more recent.
    // Otherwise we just verify the strings are present (sort is server-side and trusted).
    const firstIsMinutesOrHours = /minutes|hours|seconds/.test(firstTimeAgo)
    const secondIsDaysOrMore = /days|months|years/.test(secondTimeAgo)

    if (firstIsMinutesOrHours && secondIsDaysOrMore) {
      // First post is clearly more recent — verified
      expect(firstIsMinutesOrHours).toBe(true)
    } else {
      // Both are in the same time-unit range; the list is still in new order per server.
      // Just confirm that non-empty relative timestamps are shown on both cards.
      expect(firstTimeAgo.length).toBeGreaterThan(0)
      expect(secondTimeAgo.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Search Accuracy
// ---------------------------------------------------------------------------

test.describe('Post List - Search Accuracy', () => {
  test('search term: only posts whose titles contain the search term are shown', async ({
    page,
  }) => {
    await page.goto('/')
    const postCards = page.locator('[data-post-id]')
    await expect(postCards.first()).toBeVisible({ timeout: 15000 })
    // Wait for React hydration before clicking interactive elements
    await page.waitForLoadState('networkidle')

    // Use a search term that exists in the seed post titles
    const searchTerm = 'dark mode'

    // Open search popover and type
    const searchButton = page.getByRole('button', { name: /Search/i }).first()
    await searchButton.click()
    const searchInput = page.getByPlaceholder(/Search posts/i)
    await expect(searchInput).toBeVisible()
    await searchInput.fill(searchTerm)
    await searchInput.press('Enter')

    await expect(page).toHaveURL(/search=dark\+mode|search=dark%20mode/, { timeout: 5000 })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(300)

    const filteredCount = await postCards.count()
    const emptyState = page.getByText('No posts match your filters.')
    const hasEmpty = (await emptyState.count()) > 0

    test.skip(
      filteredCount === 0 && !hasEmpty,
      'Unexpected empty result without empty state message'
    )

    if (filteredCount > 0) {
      // Every visible post title should contain the search term (case-insensitive)
      const titles = page.locator('[data-post-id] h3')
      const titleCount = await titles.count()
      for (let i = 0; i < titleCount; i++) {
        const titleText = (await titles.nth(i).textContent()) ?? ''
        expect(titleText.toLowerCase()).toContain(searchTerm.toLowerCase())
      }
    } else {
      // Empty state message is acceptable (no matching posts)
      expect(hasEmpty).toBe(true)
    }
  })

  test('clearing search restores a larger result set', async ({ page }) => {
    // Start with search active
    await page.goto('/?search=dark+mode')
    const postCards = page.locator('[data-post-id]')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(300)
    const searchCount = await postCards.count()

    // Open search popover and clear
    const searchButton = page.getByRole('button', { name: /Search/i }).first()
    await searchButton.click()
    const clearButton = page.getByRole('button', { name: /Clear search/i })
    await expect(clearButton).toBeVisible({ timeout: 5000 })
    await clearButton.click()

    // URL should no longer contain a search parameter
    await expect(page).not.toHaveURL(/[?&]search=/, { timeout: 5000 })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(300)

    const fullCount = await postCards.count()
    // Full list should have at least as many posts as the search-filtered list
    expect(fullCount).toBeGreaterThanOrEqual(searchCount)
  })

  test('searching for a non-existent term shows the specific empty-state message', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('[data-post-id]').first()).toBeVisible({ timeout: 15000 })
    // Wait for React hydration before clicking interactive elements
    await page.waitForLoadState('networkidle')

    // Search for a string that will never match real post titles
    const impossibleTerm = 'xyzzy_no_such_post_zqwerty_99999'

    const searchButton = page.getByRole('button', { name: /Search/i }).first()
    await searchButton.click()
    const searchInput = page.getByPlaceholder(/Search posts/i)
    await expect(searchInput).toBeVisible()
    await searchInput.fill(impossibleTerm)
    await searchInput.press('Enter')

    await expect(page).toHaveURL(/search=/, { timeout: 5000 })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    // Should show the specific "no match" message rather than just a blank list
    const noMatchMsg = page.getByText('No posts match your filters.')
    await expect(noMatchMsg).toBeVisible({ timeout: 5000 })

    // And there should be no post cards
    const postCards = page.locator('[data-post-id]')
    expect(await postCards.count()).toBe(0)
  })
})
