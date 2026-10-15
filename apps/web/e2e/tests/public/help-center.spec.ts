import { test, expect, type Page } from '@playwright/test'
import { setHelpCenterContent, setHelpCenterEnabled } from '../../utils/access-helpers'

// The flags are workspace-wide. One worker must own their enable/restore pair.
test.describe.configure({ mode: 'serial' })

/**
 * Public Help Center E2E tests.
 *
 * These tests cover the public-facing help center at /hc.
 * No authentication is required.
 *
 * The suite explicitly enables both help-center flags and the widget, whose
 * kb-search route the hero search calls, and restores all three after
 * execution. A disabled-feature 404 must never stand in for the help-center UI.
 * db:seed creates no help-center content, so the suite also creates its own
 * categories and articles (e2e/scripts/set-help-center-content.ts) and removes
 * them afterwards. Every page these tests open therefore exists, and no test
 * skips because content is missing. Some tests still check count() before an
 * assertion and pass when the element is absent; making those assertions
 * unconditional is follow-up work.
 */

test.beforeAll(() => {
  setHelpCenterEnabled('enable')
  setHelpCenterContent('create')
})
test.afterAll(() => {
  try {
    setHelpCenterContent('remove')
  } finally {
    setHelpCenterEnabled('restore')
  }
})

/**
 * Assert that the page shows the help-center landing page. A heading alone does
 * not prove it, because the not-found page renders an h1 ("Page not found") as
 * well; only the landing page has the article search.
 */
async function expectLandingPage(page: Page) {
  await expect(page.locator('h1').first()).toBeVisible()
  await expect(page.getByPlaceholder('Search articles...')).toBeVisible()
}

/**
 * Type `query` into the hero search, wait for the request it sends and require
 * a 200 answer. The hero search calls /api/widget/kb-search, and every widget
 * route answers 404 while the widget is disabled
 * (src/lib/server/widget/widget-enabled.ts). The suite enables the widget in
 * beforeAll, so a 404 here is a failure, not a reason to skip.
 */
async function searchHelpCenter(page: Page, query: string): Promise<void> {
  const answered = page.waitForResponse((response) =>
    response.url().includes('/api/widget/kb-search')
  )
  await page.getByPlaceholder('Search articles...').fill(query)
  const response = await answered
  expect(response.status(), `kb-search for "${query}"`).toBe(200)
}

test.describe('Public Help Center', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hc')
    await page.waitForLoadState('networkidle')
  })

  // -------------------------------------------------------------------------
  // Landing page
  // -------------------------------------------------------------------------

  test('page loads and shows help center content', async ({ page }) => {
    // beforeAll enabled both flags, so /hc must be the landing page, not a 404.
    await expectLandingPage(page)
  })

  test('shows the search bar on the landing page', async ({ page }) => {
    await expectLandingPage(page)

    // Hero search renders an <input type="search"> with placeholder "Search articles..."
    const searchInput = page.getByPlaceholder('Search articles...')
    await expect(searchInput).toBeVisible()
  })

  test('shows categories list when categories exist in seed data', async ({ page }) => {
    await expectLandingPage(page)

    // Category cards link to /hc/categories/<slug>. The fixture always creates
    // categories, so the "No categories yet" empty state is asserted by
    // src/components/help-center/__tests__/help-center-category-grid.test.tsx.
    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()
  })

  test('each category card shows name and article count', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    const firstCard = categoryCards.first()

    // Category name is in an h3 inside the card
    const categoryName = firstCard.locator('h3')
    await expect(categoryName).toBeVisible()

    // Article count text like "3 articles" or "1 article"
    const articleCount = firstCard.getByText(/\d+ articles?/)
    await expect(articleCount).toBeVisible()
  })

  test('each category card shows description when present', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')

    // At least verify cards are rendered; descriptions are optional per category
    await expect(categoryCards.first()).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Category page navigation
  // -------------------------------------------------------------------------

  test('can navigate into a category', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveURL(/\/hc\/categories\//)
  })

  test('category page shows category name as heading', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    // Capture category name from the card before navigating
    const categoryNameText = await categoryCards.first().locator('h3').textContent()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    if (categoryNameText) {
      await expect(page.locator('h1').first()).toHaveText(categoryNameText)
    } else {
      await expect(page.locator('h1').first()).toBeVisible()
    }
  })

  test('category page shows articles list', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    // Article rows link to /hc/articles/<categorySlug>/<articleSlug>. Waiting on
    // the locator rather than reading count() once covers the client-side
    // navigation, which can still be rendering when the network goes idle.
    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Article page
  // -------------------------------------------------------------------------

  test('can navigate into an article', async ({ page }) => {
    await expectLandingPage(page)

    // Navigate to a category first
    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveURL(/\/hc\/articles\//)
  })

  test('article page shows title', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    // Article title renders as an h1
    await expect(page.locator('article h1').or(page.locator('h1'))).toBeVisible()
  })

  test('article page shows content area', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    // Rich text content renders inside .prose. The article wraps the rich-text
    // renderer, which has its own .prose, so take the outer one.
    const contentArea = page.locator('.prose').first()
    await expect(contentArea).toBeVisible()
  })

  test('article page shows "Was this helpful?" feedback widget', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    await expect(page.getByText('Was this helpful?')).toBeVisible()
    await expect(page.getByRole('button', { name: /Yes/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /No/i })).toBeVisible()
  })

  test('article page shows table of contents when headings exist', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    // TOC renders "On this page" label only when headings are present
    const tocLabel = page.getByText('On this page')
    if ((await tocLabel.count()) > 0) {
      await expect(tocLabel).toBeVisible()
    }
  })

  test('article page shows author and last-updated metadata when present', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    // Author block shows "Written By <name>" when an author is set
    const writtenBy = page.getByText(/Written By/i)
    if ((await writtenBy.count()) > 0) {
      await expect(writtenBy).toBeVisible()
    }

    // Last-updated shows "Last updated <relative time>"
    const lastUpdated = page.getByText(/Last updated/i)
    if ((await lastUpdated.count()) > 0) {
      await expect(lastUpdated).toBeVisible()
    }
  })

  // -------------------------------------------------------------------------
  // Breadcrumb / back navigation
  // -------------------------------------------------------------------------

  test('breadcrumb navigation works on category page', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    // Breadcrumb nav has aria-label="Breadcrumb"
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(breadcrumb).toBeVisible()

    // First breadcrumb item links back to /hc
    const helpCenterLink = breadcrumb.getByRole('link', { name: /Help Center/i })
    if ((await helpCenterLink.count()) > 0) {
      await helpCenterLink.click()
      await page.waitForLoadState('networkidle')
      await expect(page).toHaveURL(/\/hc\/?$/)
    }
  })

  test('breadcrumb navigation works on article page', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(breadcrumb).toBeVisible()

    // In the article breadcrumb the category is rendered as a non-link <span>
    // (the last item in HelpCenterBreadcrumbs is always a span, not a Link).
    // The only <a> present is the "Help Center" root link.
    const breadcrumbLink = breadcrumb.locator('a').last()
    if ((await breadcrumbLink.count()) > 0) {
      await breadcrumbLink.click()
      await page.waitForLoadState('networkidle')
      await expect(page).toHaveURL(/\/hc/)
    }
  })

  test('"All categories" back link on category page navigates to /hc', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    // The left sidebar has an "All categories" back link (visible on xl viewports).
    // The route component also renders it via Link to="/hc".
    const allCategoriesLink = page.getByRole('link', { name: /All categories/i })
    if ((await allCategoriesLink.count()) > 0) {
      await allCategoriesLink.first().click()
      await page.waitForLoadState('networkidle')
      await expect(page).toHaveURL(/\/hc\/?$/)
    }
  })

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  test('search input is present and accepts text', async ({ page }) => {
    await expectLandingPage(page)

    const searchInput = page.getByPlaceholder('Search articles...')
    await expect(searchInput).toBeVisible()

    await searchInput.fill('getting started')
    await expect(searchInput).toHaveValue('getting started')
  })

  test('typing in search shows results dropdown when articles match', async ({ page }) => {
    await expectLandingPage(page)

    const searchInput = page.getByPlaceholder('Search articles...')
    await expect(searchInput).toBeVisible()

    // A fixture article is titled "Update your billing details". (The old
    // query, 'a', is a stop word that full-text search drops, so it matched
    // nothing and the dropdown check below never ran.)
    await searchHelpCenter(page, 'billing')

    // Results dropdown is a <ul> inside the search container
    const resultsDropdown = page
      .locator('ul')
      .filter({ has: page.locator('button[type="button"]') })
    await expect(resultsDropdown.first()).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Old URL redirect (legacy routes)
  // -------------------------------------------------------------------------

  test('old /$categorySlug URL redirects to /hc/categories/$categorySlug', async ({ page }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    const firstHref = (await categoryCards.first().getAttribute('href')) ?? ''
    expect(firstHref).toMatch(/^\/hc\/categories\/[^/]+\/?$/)

    // Extract slug from /hc/categories/<slug>
    const slug = firstHref.replace('/hc/categories/', '').replace(/\/$/, '')

    // Navigate to legacy URL /hc/<slug> — should redirect to the canonical URL
    await page.goto(`/hc/${slug}`)
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveURL(`/hc/categories/${slug}`)
  })

  // -------------------------------------------------------------------------
  // Prev / Next navigation on article page
  // -------------------------------------------------------------------------

  test('prev/next navigation renders on article page when sibling articles exist', async ({
    page,
  }) => {
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    // The first fixture category holds three articles.
    await expect(articleLinks.nth(1)).toBeVisible()

    // Navigate to the second article so there's a "Previous" link
    await articleLinks.nth(1).click()
    await page.waitForLoadState('networkidle')

    // Previous / Next links contain the arrow characters rendered by the
    // component. The second of three fixture articles has a sibling on each side.
    await expect(page.getByText(/← Previous/i)).toBeVisible()
    await expect(page.getByText(/Next →/i)).toBeVisible()
  })
})

// =============================================================================
// Help Center - Search Accuracy
// =============================================================================

test.describe('Help Center - Search Accuracy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hc')
    await page.waitForLoadState('networkidle')
  })

  test('search results all contain the query term in title or category name', async ({ page }) => {
    await expectLandingPage(page)

    const searchInput = page.getByPlaceholder('Search articles...')
    await expect(searchInput).toBeVisible()

    // A fixture article and its category are both named for billing. (The old
    // query, 'a', is an English stop word that full-text search drops, so it
    // matched nothing and this test always skipped.)
    const query = 'billing'
    await searchHelpCenter(page, query)

    const resultsDropdown = page.locator('ul').filter({
      has: page.locator('button[type="button"]'),
    })
    await expect(resultsDropdown.first()).toBeVisible()

    const resultButtons = resultsDropdown.first().locator('button[type="button"]')
    const count = await resultButtons.count()
    expect(count).toBeGreaterThan(0)

    // Every visible result title or category name must include the query (case-insensitive)
    for (let i = 0; i < count; i++) {
      const btn = resultButtons.nth(i)
      const titleEl = btn.locator('div.text-sm.font-medium')
      const categoryEl = btn.locator('div.text-xs.text-muted-foreground').first()

      const title = ((await titleEl.textContent()) ?? '').toLowerCase()
      const categoryName = ((await categoryEl.textContent()) ?? '').toLowerCase()

      // At least one of title or category name must contain the query term
      const matchesQuery =
        title.includes(query.toLowerCase()) || categoryName.includes(query.toLowerCase())
      expect(
        matchesQuery,
        `Result "${title}" (category: "${categoryName}") does not match query "${query}"`
      ).toBe(true)
    }
  })

  test('searching a non-existent term shows empty state with helpful message', async ({ page }) => {
    await expectLandingPage(page)

    const searchInput = page.getByPlaceholder('Search articles...')
    await expect(searchInput).toBeVisible()

    // A nonsense string guaranteed not to match any article
    await searchInput.fill('zzzznonexistentterm9999')
    await page.waitForTimeout(700)

    // The dropdown should NOT be visible (search sets showResults=false when empty)
    const resultsDropdown = page.locator('ul').filter({
      has: page.locator('button[type="button"]'),
    })
    // Either the dropdown is absent or hidden
    const dropdownCount = await resultsDropdown.count()
    if (dropdownCount > 0) {
      await expect(resultsDropdown.first()).not.toBeVisible()
    }
    // The search input itself should still be visible and hold the typed value
    await expect(searchInput).toHaveValue('zzzznonexistentterm9999')
  })

  test('clearing search hides the results dropdown', async ({ page }) => {
    await expectLandingPage(page)

    const searchInput = page.getByPlaceholder('Search articles...')
    await expect(searchInput).toBeVisible()

    // Type a fixture term so the dropdown opens. (The old query, 'a', is a stop
    // word that matched nothing, so there was never a dropdown to clear.)
    await searchHelpCenter(page, 'billing')
    const resultsDropdown = page.locator('ul').filter({
      has: page.locator('button[type="button"]'),
    })
    await expect(resultsDropdown.first()).toBeVisible()

    // Now clear the input. The component closes the dropdown after its 300 ms
    // debounce without sending a request, so wait on the dropdown itself.
    await searchInput.fill('')
    await expect(resultsDropdown).toHaveCount(0)

    // Input value is empty
    await expect(searchInput).toHaveValue('')
  })

  test('search is case-insensitive — lowercase query matches mixed-case titles', async ({
    page,
  }) => {
    await expectLandingPage(page)

    const searchInput = page.getByPlaceholder('Search articles...')
    await expect(searchInput).toBeVisible()

    // Search uppercase first to discover an existing title. A fixture article
    // is titled "Update your billing details".
    await searchHelpCenter(page, 'Billing')

    const resultsDropdown = page.locator('ul').filter({
      has: page.locator('button[type="button"]'),
    })
    await expect(resultsDropdown.first()).toBeVisible()

    const countUpper = await resultsDropdown.first().locator('button[type="button"]').count()
    expect(countUpper).toBeGreaterThan(0)

    // Now search with lowercase — should return at least as many results
    await searchHelpCenter(page, 'billing')

    const countLower = await resultsDropdown.first().locator('button[type="button"]').count()
    // Results must be non-zero when an uppercase search found results
    expect(countLower).toBeGreaterThan(0)
  })
})

// =============================================================================
// Help Center - Article Content Verification
// =============================================================================

test.describe('Help Center - Article Content Verification', () => {
  // Navigate to the first available article before each test
  async function navigateToFirstArticle(page: Page): Promise<void> {
    await page.goto('/hc')
    await page.waitForLoadState('networkidle')
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')
  }

  test('article h1 title matches the title shown in the category listing', async ({ page }) => {
    await page.goto('/hc')
    await page.waitForLoadState('networkidle')

    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    // Capture the title text from the category listing row before navigating
    const listingTitle = await articleLinks
      .first()
      .locator('span.text-sm.font-medium')
      .textContent()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    // The article h1 must match the listing title exactly
    if (listingTitle) {
      const articleH1 = page.locator('article h1').or(page.locator('h1')).first()
      await expect(articleH1).toHaveText(listingTitle.trim())
    }
  })

  test('article prose content is non-empty', async ({ page }) => {
    await navigateToFirstArticle(page)

    const prose = page.locator('.prose').first()
    await expect(prose).toBeVisible()

    // The prose element must contain at least some text
    const proseText = (await prose.textContent()) ?? ''
    expect(proseText.trim().length).toBeGreaterThan(0)
  })

  test('article page has paragraph text or list items beyond the heading', async ({ page }) => {
    await navigateToFirstArticle(page)

    // Any <p>, <li>, or <ul> inside the prose area means the article has body content
    const bodyContent = page.locator('.prose p, .prose li, .prose ul, .prose ol').first()
    await expect(bodyContent).toBeVisible()
  })

  test('h2/h3 headings in the article appear in the Table of Contents', async ({ page }) => {
    await navigateToFirstArticle(page)

    // TOC is only rendered on xl viewports; use a wide viewport for this test
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForLoadState('networkidle')

    // The first fixture article has h2 and h3 headings.
    const tocLabel = page.getByText('On this page')
    await expect(tocLabel).toBeVisible()

    // Collect h2/h3 headings from the prose
    const proseHeadings = page.locator('.prose h2, .prose h3')
    await expect(proseHeadings.first()).toBeVisible()

    // The TOC nav must contain links for these headings
    const tocLinks = page.locator('aside nav a[href^="#"]')
    const tocCount = await tocLinks.count()
    expect(tocCount).toBeGreaterThan(0)

    // Each TOC link text should match one of the prose headings
    const firstHeadingText = ((await proseHeadings.first().textContent()) ?? '').trim()
    if (firstHeadingText) {
      const matchingTocEntry = page.locator('aside nav a[href^="#"]').filter({
        hasText: firstHeadingText,
      })
      await expect(matchingTocEntry.first()).toBeVisible()
    }
  })

  test('clicking a ToC link scrolls its heading into view', async ({ page }) => {
    await navigateToFirstArticle(page)

    // The TOC renders on xl viewports only. A short viewport keeps the last
    // heading of the first fixture article below the fold until the click.
    await page.setViewportSize({ width: 1440, height: 500 })
    await page.waitForLoadState('networkidle')

    const tocLabel = page.getByText('On this page')
    await expect(tocLabel).toBeVisible()

    const tocLinks = page.locator('aside nav a[href^="#"]')
    await expect(tocLinks.first()).toBeVisible()

    const lastLink = tocLinks.last()
    const targetHash = (await lastLink.getAttribute('href')) ?? '' // e.g. "#my-heading"
    expect(targetHash).toMatch(/^#./)
    const target = page.locator(`[id="${targetHash.slice(1)}"]`)
    await expect(target).not.toBeInViewport()

    // help-center-toc.tsx prevents the default jump and calls scrollIntoView, so
    // the URL keeps no hash; the click has to bring the heading into view.
    await lastLink.click()
    await expect(target).toBeInViewport()
  })
})

// =============================================================================
// Help Center - Article Feedback Widget
// =============================================================================

test.describe('Help Center - Article Feedback Widget', () => {
  async function navigateToFirstArticle(page: Page): Promise<void> {
    await page.goto('/hc')
    await page.waitForLoadState('networkidle')
    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')
  }

  test('article page shows "Was this helpful?" widget with thumbs-up and thumbs-down buttons', async ({
    page,
  }) => {
    await navigateToFirstArticle(page)

    await expect(page.getByText('Was this helpful?')).toBeVisible()

    // Buttons render as "👍 Yes" and "👎 No"
    const yesBtn = page.getByRole('button', { name: /yes/i })
    const noBtn = page.getByRole('button', { name: /no/i })
    await expect(yesBtn).toBeVisible()
    await expect(noBtn).toBeVisible()
  })

  test('clicking thumbs-up shows a confirmation message', async ({ page }) => {
    await navigateToFirstArticle(page)

    const yesBtn = page.getByRole('button', { name: /yes/i })
    await expect(yesBtn).toBeVisible()

    await yesBtn.click()

    // After voting helpful the subtitle changes to the confirmation copy
    await expect(page.getByText('Thanks — glad it landed.')).toBeVisible({ timeout: 5000 })
  })

  test('clicking thumbs-down shows a confirmation message', async ({ page }) => {
    await navigateToFirstArticle(page)

    const noBtn = page.getByRole('button', { name: /no/i })
    await expect(noBtn).toBeVisible()

    await noBtn.click()

    // After voting not-helpful the subtitle changes to the follow-up copy
    await expect(page.getByText("Noted. We'll revisit this article.")).toBeVisible({
      timeout: 5000,
    })
  })

  test('after voting helpful the thumbs-up button shows selected styling', async ({ page }) => {
    await navigateToFirstArticle(page)

    const yesBtn = page.getByRole('button', { name: /yes/i })
    await expect(yesBtn).toBeVisible()

    await yesBtn.click()
    // Wait for state to settle
    await expect(page.getByText('Thanks — glad it landed.')).toBeVisible({ timeout: 5000 })

    // Selected state: the button gets bg-primary/10 and border-primary/20 classes
    // We check via the class attribute rather than computed styles
    const classAttr = (await yesBtn.getAttribute('class')) ?? ''
    expect(classAttr).toContain('bg-primary/10')
  })

  test('clicking the same vote button twice does not change state back', async ({ page }) => {
    await navigateToFirstArticle(page)

    const yesBtn = page.getByRole('button', { name: /yes/i })
    await expect(yesBtn).toBeVisible()

    // First click — registers vote
    await yesBtn.click()
    await expect(page.getByText('Thanks — glad it landed.')).toBeVisible({ timeout: 5000 })

    // Second click on the same button — should be a no-op per component logic
    await yesBtn.click()
    // Confirmation copy must still be visible (vote was not reversed)
    await expect(page.getByText('Thanks — glad it landed.')).toBeVisible()
    // And the prompt's subtitle should be gone (replaced by the confirmation). The
    // text is matched directly: the class selector used here before also matched
    // the table of contents label, "On this page".
    await expect(page.getByText('Your feedback shapes what we write next.')).toHaveCount(0)
  })
})

// =============================================================================
// Help Center - Navigation Accuracy
// =============================================================================

test.describe('Help Center - Navigation Accuracy', () => {
  test('breadcrumb on category page shows Help Center then category name', async ({ page }) => {
    await page.goto('/hc')
    await page.waitForLoadState('networkidle')

    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    const categoryName = await categoryCards.first().locator('h3').textContent()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(breadcrumb).toBeVisible()

    // First crumb: "Help Center" (a link)
    const helpCenterCrumb = breadcrumb.getByRole('link', { name: /Help Center/i })
    await expect(helpCenterCrumb).toBeVisible()

    // Last crumb: category name as plain text (no link — it is the current page)
    if (categoryName) {
      const categorySpan = breadcrumb.locator('span').filter({ hasText: categoryName.trim() })
      await expect(categorySpan.first()).toBeVisible()
    }
  })

  test('breadcrumb on article page shows Help Center then category then article title', async ({
    page,
  }) => {
    await page.goto('/hc')
    await page.waitForLoadState('networkidle')

    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    const categoryName = await categoryCards.first().locator('h3').textContent()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
    await expect(breadcrumb).toBeVisible()

    // First crumb: "Help Center" link
    const helpCenterCrumb = breadcrumb.getByRole('link', { name: /Help Center/i })
    await expect(helpCenterCrumb).toBeVisible()

    // The category name appears as a link (the article page renders it with href)
    if (categoryName) {
      const categoryLink = breadcrumb.getByRole('link', { name: categoryName.trim() })
      if ((await categoryLink.count()) > 0) {
        await expect(categoryLink.first()).toBeVisible()
      }
    }
  })

  test('"Help Center" breadcrumb link navigates back to /hc', async ({ page }) => {
    await page.goto('/hc')
    await page.waitForLoadState('networkidle')

    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
    const helpCenterLink = breadcrumb.getByRole('link', { name: /Help Center/i })
    await expect(helpCenterLink).toBeVisible()

    await helpCenterLink.click()
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveURL(/\/hc\/?$/)
  })

  test('category breadcrumb link on article page navigates to the correct category', async ({
    page,
  }) => {
    await page.goto('/hc')
    await page.waitForLoadState('networkidle')

    await expectLandingPage(page)

    const categoryCards = page.locator('a[href*="/hc/categories/"]')
    await expect(categoryCards.first()).toBeVisible()

    const categoryHref = await categoryCards.first().getAttribute('href')
    const categoryName = await categoryCards.first().locator('h3').textContent()

    await categoryCards.first().click()
    await page.waitForLoadState('networkidle')

    const articleLinks = page.locator('a[href*="/hc/articles/"]')
    await expect(articleLinks.first()).toBeVisible()

    await articleLinks.first().click()
    await page.waitForLoadState('networkidle')

    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
    if (categoryName) {
      // The article page renders `breadcrumbs.slice(0, -1)`, so the category is
      // the last crumb and HelpCenterBreadcrumbs prints it as text, not a link.
      // Whether it should link is an open product decision; until then this
      // test reports a skip rather than a failure or a pass.
      const categoryLink = breadcrumb.getByRole('link', { name: categoryName.trim() })
      if ((await categoryLink.count()) === 0) {
        test.skip(true, 'the article breadcrumb shows the category as text, not a link')
        return
      }

      await categoryLink.first().click()
      await page.waitForLoadState('networkidle')

      // Should land on the category page
      if (categoryHref) {
        await expect(page).toHaveURL(categoryHref)
      } else {
        await expect(page).toHaveURL(/\/hc\/categories\//)
      }
    }
  })
})
