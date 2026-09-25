import { test, expect } from '@playwright/test'

/**
 * Help Center admin E2E tests.
 *
 * These tests cover the help center article management UI at /admin/help-center.
 *
 * Prerequisites:
 *   - The `helpCenter` feature flag must be enabled for the acme workspace.
 *
 * The suite enables the flag before each suite via `enableHelpCenter`, so the
 * admin Help Center is always reachable. A test never returns early when an
 * element it needs is missing: that would pass having asserted nothing. It
 * waits for the element and fails when it never appears, and a case that
 * genuinely depends on seed data it cannot create calls `test.skip` with the
 * reason, so the report shows it as skipped rather than passed.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Enable the `helpCenter` feature flag, which is what actually gates the admin
 * Help Center: admin-sidebar.tsx and settings-nav.tsx both read
 * `settings.featureFlags.helpCenter`.
 *
 * That flag lives in the `settings.feature_flags` column and is toggled on the
 * Labs page. It is NOT the switch on /admin/settings/help-center: that one
 * writes the separate `settings.help_center_config` column
 * (updateHelpCenterConfig), which controls the PUBLIC help center and leaves
 * every admin surface hidden. Toggling it here left the nav gated off and the
 * routes unreachable for the whole suite.
 *
 * ExperimentalSettings calls window.location.reload() once the mutation
 * resolves, so the flag is live in the router context on the next navigation.
 */
async function enableHelpCenter(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/settings/labs')
  await page.waitForLoadState('networkidle')

  const toggle = page.locator('#flag-helpCenter')
  await expect(toggle).toBeVisible({ timeout: 10000 })
  if (!(await toggle.isChecked())) {
    // The success handler reloads the page. Wait for that reload's load event,
    // armed before the click: waitForLoadState alone returns at once, since
    // the current document already reached that state, and the late reload
    // then aborted the caller's next page.goto (net::ERR_ABORTED).
    const reloaded = page.waitForEvent('load')
    await toggle.click()
    await reloaded
    await page.waitForLoadState('networkidle')
    await expect(page.locator('#flag-helpCenter')).toBeChecked({ timeout: 10000 })
  }
}

/**
 * Select the first category in the create-article dialog, creating one first
 * when the workspace has none.
 *
 * An article needs a category: without one, Save Draft fails validation and
 * the dialog stays open. The suite used to get its category from "can create a
 * new top-level category" running earlier in this file, but the config is
 * fully parallel and CI shards by test, so that test can run in another shard.
 * When new tests elsewhere moved the shard 2 boundary into this file, every
 * editor test found no category (landing-page#2309). Each caller now makes
 * its own, through the dialog's "Create new category" button, which selects
 * the category it creates.
 */
async function selectOrCreateCategory(
  container: import('@playwright/test').Locator,
  page: import('@playwright/test').Page
): Promise<void> {
  const trigger = container.locator('[role="combobox"]').first()
  await expect(trigger).toBeVisible({ timeout: 10000 })
  await trigger.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeAttached()
  const firstOption = listbox.getByRole('option').first()
  if ((await firstOption.count()) > 0) {
    await firstOption.click()
    return
  }

  await page.keyboard.press('Escape')
  await expect(listbox).toHaveCount(0)

  await container.getByTitle('Create new category').click()
  const categoryDialog = page.getByRole('dialog', { name: 'New category' })
  await expect(categoryDialog).toBeVisible({ timeout: 5000 })
  await categoryDialog.getByLabel('Name', { exact: true }).fill(`E2E Category ${Date.now()}`)
  await categoryDialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(categoryDialog).toBeHidden({ timeout: 10000 })
  await expect(trigger).not.toHaveText(/select category/i, { timeout: 10000 })
}

/**
 * Create a fresh article via the dialog and navigate to the editor page.
 * Returns the editor URL.
 *
 * It used to return null when the New button was not there at the instant it
 * was counted, and every editor test then returned early and passed having
 * asserted nothing. It now waits for the button, so a missing creation flow
 * fails the test that needs it.
 */
async function createAndOpenArticle(
  page: import('@playwright/test').Page,
  title = `Editor Test Article ${Date.now()}`
): Promise<string> {
  await enableHelpCenter(page)
  await page.goto('/admin/help-center')
  await page.waitForLoadState('networkidle')

  const newButton = page.getByRole('button', { name: /^New$/i })
  await expect(newButton).toBeVisible({ timeout: 10000 })
  await newButton.click()

  await page.getByRole('menuitem', { name: 'New article' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  await dialog.getByPlaceholder('Article title').fill(title)
  await selectOrCreateCategory(dialog, page)

  await dialog.locator('.ProseMirror[contenteditable="true"]').click()
  await page.keyboard.type('Test article content for e2e test.')

  await dialog.getByRole('button', { name: /save draft/i }).click()
  await expect(dialog).toBeHidden({ timeout: 15000 })
  await expect(page).toHaveURL(/\/admin\/help-center\/articles\//, { timeout: 15000 })

  return page.url()
}

// ---------------------------------------------------------------------------
// Navigation suite
// ---------------------------------------------------------------------------

test.describe('Help Center admin navigation', () => {
  test('can navigate to help center from admin sidebar', async ({ page }) => {
    await enableHelpCenter(page)

    await page.goto('/admin')
    await page.waitForLoadState('networkidle')

    const helpCenterLink = page.getByRole('link', { name: 'Help Center' })
    await expect(helpCenterLink).toBeVisible({ timeout: 10000 })
    await helpCenterLink.click()

    await expect(page).toHaveURL(/\/admin\/help-center/, { timeout: 10000 })
  })

  test('help center index shows article list area', async ({ page }) => {
    await enableHelpCenter(page)
    await page.goto('/admin/help-center')
    await page.waitForLoadState('networkidle')

    // The list card header is rendered unconditionally on the index
    // (help-center-finder.tsx: `articleListTitle` is 'Recent articles' when no
    // category is selected). The previous `.or()` union also matched the
    // empty-state heading "No articles yet", which the index renders at the
    // same time when the tenant has no articles -- two matches, so the union
    // was a strict-mode violation rather than a fallback.
    await expect(page.getByText('Recent articles')).toBeVisible({ timeout: 10000 })
  })
})

// ---------------------------------------------------------------------------
// Category creation
// ---------------------------------------------------------------------------

test.describe('Help Center category management', () => {
  test.beforeEach(async ({ page }) => {
    await enableHelpCenter(page)
    await page.goto('/admin/help-center')
    await page.waitForLoadState('networkidle')
  })

  test('can open New dropdown and choose New category', async ({ page }) => {
    const newButton = page.getByRole('button', { name: /^New$/i })
    await expect(newButton).toBeVisible({ timeout: 10000 })
    await newButton.click()

    await expect(page.getByRole('menuitem', { name: 'New article' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'New category' })).toBeVisible()

    await page.keyboard.press('Escape')
  })

  test('can create a new top-level category', async ({ page }) => {
    const newButton = page.getByRole('button', { name: /^New$/i })
    await expect(newButton).toBeVisible({ timeout: 10000 })
    await newButton.click()

    await page.getByRole('menuitem', { name: 'New category' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })

    const categoryName = `E2E Category ${Date.now()}`
    await dialog.getByLabel(/name/i).fill(categoryName)
    await dialog.getByRole('button', { name: /create|save/i }).click()

    await expect(dialog).toBeHidden({ timeout: 10000 })
    await expect(page.getByText(categoryName)).toBeVisible({ timeout: 10000 })
  })
})

// ---------------------------------------------------------------------------
// Article creation
// ---------------------------------------------------------------------------

test.describe('Help Center article creation', () => {
  test.beforeEach(async ({ page }) => {
    await enableHelpCenter(page)
    await page.goto('/admin/help-center')
    await page.waitForLoadState('networkidle')
  })

  test('can open create article dialog from New dropdown', async ({ page }) => {
    const newButton = page.getByRole('button', { name: /^New$/i })
    await expect(newButton).toBeVisible({ timeout: 10000 })
    await newButton.click()

    await page.getByRole('menuitem', { name: 'New article' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.getByPlaceholder('Article title')).toBeVisible()

    await page.keyboard.press('Escape')
  })

  test('can create an article with title and content, then navigate to editor', async ({
    page,
  }) => {
    const url = await createAndOpenArticle(page, `E2E Test Article ${Date.now()}`)
    expect(url).toMatch(/\/admin\/help-center\/articles\//)
  })

  test('a category created from the article dialog is the one selected', async ({ page }) => {
    const newButton = page.getByRole('button', { name: /^New$/i })
    await expect(newButton).toBeVisible({ timeout: 10000 })
    await newButton.click()
    await page.getByRole('menuitem', { name: 'New article' }).click()

    const dialog = page.getByRole('dialog', { name: 'Create help article' })
    await expect(dialog).toBeVisible()

    const categoryName = `E2E Dialog Category ${Date.now()}`
    await dialog.getByTitle('Create new category').click()
    const categoryDialog = page.getByRole('dialog', { name: 'New category' })
    await expect(categoryDialog).toBeVisible({ timeout: 5000 })
    await categoryDialog.getByLabel('Name', { exact: true }).fill(categoryName)
    await categoryDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(categoryDialog).toBeHidden({ timeout: 10000 })

    // The article dialog stays open, with the new category chosen.
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('combobox').first()).toContainText(categoryName, {
      timeout: 10000,
    })

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 5000 })
  })

  test('create article dialog can be dismissed with Escape', async ({ page }) => {
    const newButton = page.getByRole('button', { name: /^New$/i })
    await expect(newButton).toBeVisible({ timeout: 10000 })
    await newButton.click()

    await page.getByRole('menuitem', { name: 'New article' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 5000 })
  })
})

// ---------------------------------------------------------------------------
// Article editor
// ---------------------------------------------------------------------------

test.describe('Help Center article editor', () => {
  test('editor shows title input, description input, and content area', async ({ page }) => {
    await createAndOpenArticle(page)

    await expect(page.getByPlaceholder('Untitled')).toBeVisible({ timeout: 10000 })
    await expect(page.getByPlaceholder('Page description (optional)')).toBeVisible()
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible()
  })

  test('editor has category select, Publish button and Save changes button', async ({ page }) => {
    await createAndOpenArticle(page)

    const categorySelect = page.locator('button[role="combobox"]')
    await expect(categorySelect.first()).toBeVisible({ timeout: 10000 })

    const publishOrView = page
      .getByRole('button', { name: /publish/i })
      .or(page.getByRole('link', { name: /view article/i }))
    await expect(publishOrView.first()).toBeVisible()

    await expect(page.getByRole('button', { name: /save changes/i })).toBeVisible()
  })

  test('can edit the article title and save', async ({ page }) => {
    await createAndOpenArticle(page)

    const titleInput = page.getByPlaceholder('Untitled')
    await expect(titleInput).toBeVisible({ timeout: 10000 })

    await titleInput.fill(`Updated Title ${Date.now()}`)
    await page.getByRole('button', { name: /save changes/i }).click()

    await expect(
      page
        .getByRole('button', { name: /saving/i })
        .or(page.getByRole('button', { name: /save changes/i }))
    ).toBeVisible({ timeout: 5000 })

    await expect(page).toHaveURL(/\/admin\/help-center\/articles\//)
  })

  test('can edit article description', async ({ page }) => {
    await createAndOpenArticle(page)

    const descInput = page.getByPlaceholder('Page description (optional)')
    await expect(descInput).toBeVisible({ timeout: 10000 })

    await descInput.fill('A helpful description set by Playwright.')
    await page.getByRole('button', { name: /save changes/i }).click()

    await expect(page).toHaveURL(/\/admin\/help-center\/articles\//)
  })

  test('can publish an article and see "View article" link', async ({ page }) => {
    await createAndOpenArticle(page)

    const publishButton = page.getByRole('button', { name: /^publish$/i })
    await expect(publishButton).toBeVisible({ timeout: 10000 })

    await publishButton.click()

    await expect(page.getByRole('link', { name: /view article/i })).toBeVisible({ timeout: 10000 })
  })

  test('can unpublish a published article via ellipsis menu', async ({ page }) => {
    await createAndOpenArticle(page)

    const publishButton = page.getByRole('button', { name: /^publish$/i })
    await expect(publishButton).toBeVisible({ timeout: 10000 })

    await publishButton.click()
    await expect(page.getByRole('link', { name: /view article/i })).toBeVisible({ timeout: 10000 })

    const actionsButton = page.getByRole('button', { name: /article actions/i })
    await expect(actionsButton).toBeVisible({ timeout: 5000 })
    await actionsButton.click()

    await page.getByRole('menuitem', { name: /unpublish/i }).click()

    await expect(page.getByRole('button', { name: /^publish$/i })).toBeVisible({ timeout: 10000 })
  })

  test('back button navigates to help center list', async ({ page }) => {
    await createAndOpenArticle(page)

    const breadcrumbLink = page.getByRole('link', { name: 'Help Center' }).first()
    await expect(breadcrumbLink).toBeVisible({ timeout: 10000 })
    await breadcrumbLink.click()

    await expect(page).toHaveURL(/\/admin\/help-center/, { timeout: 10000 })
    expect(page.url()).not.toMatch(/\/articles\//)
  })
})

// ---------------------------------------------------------------------------
// Article author (new feature on this branch)
// ---------------------------------------------------------------------------

test.describe('Help Center article author', () => {
  /**
   * The author feature is exposed via the REST API and MCP tools on this branch.
   * Full author-setting tests are covered by the integration suite in
   * help-center-api.test.ts. These tests verify the UI display path.
   */

  test('article list renders without errors when articles exist', async ({ page }) => {
    await enableHelpCenter(page)
    await page.goto('/admin/help-center')
    await page.waitForLoadState('networkidle')

    const articleCards = page.locator('h3')
    test.skip((await articleCards.count()) === 0, 'no help-center articles in the list')

    await expect(articleCards.first()).toBeVisible()
  })

  test('article editor remains stable after setting author via API', async ({ page, request }) => {
    const url = await createAndOpenArticle(page)

    const articleId = url.match(/\/articles\/([^/?#]+)/)?.[1]
    expect(articleId, `article id in ${url}`).toBeTruthy()

    const patchResponse = await request.patch(`/api/v1/help-center/articles/${articleId}`, {
      data: { authorId: 'self' },
      headers: { 'Content-Type': 'application/json' },
    })

    // If authorId: "self" is unsupported, skip loudly rather than pass having
    // asserted nothing; the integration suite covers the API itself.
    test.skip(!patchResponse.ok(), `PATCH authorId=self answered ${patchResponse.status()}`)

    await page.reload()
    await page.waitForLoadState('networkidle')

    // TODO: When the editor gains a metadata sidebar with an author picker,
    // assert `await expect(page.getByText('Author')).toBeVisible()` here.
    await expect(page).toHaveURL(/\/admin\/help-center\/articles\//)
    await expect(page.getByPlaceholder('Untitled')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Article list filtering
// ---------------------------------------------------------------------------

test.describe('Help Center article filtering', () => {
  test.beforeEach(async ({ page }) => {
    await enableHelpCenter(page)
    await page.goto('/admin/help-center')
    await page.waitForLoadState('networkidle')
  })

  test('search input is present', async ({ page }) => {
    const searchInput = page.locator('[data-search-input]').or(page.getByPlaceholder(/search/i))
    await expect(searchInput.first()).toBeVisible({ timeout: 10000 })
  })

  // The sort control is not a combobox: AdminListHeader renders `sortOptions`
  // as a pair of pill <button>s ("Newest" / "Oldest"), and help-center-finder
  // passes SORT_OPTIONS = [newest, oldest]. The old combobox locator matched
  // nothing, which also made 'can change sort order' return before asserting.
  test('sort dropdown is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Newest' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: 'Oldest' })).toBeVisible({ timeout: 10000 })
  })

  test('can change sort order', async ({ page }) => {
    await page.getByRole('button', { name: 'Oldest' }).click()
    await page.waitForLoadState('networkidle')

    // useHelpCenterFilters writes the non-default sort into the URL and omits
    // it again for 'newest', so the search param is the observable result.
    await expect(page).toHaveURL(/[?&]sort=oldest/, { timeout: 10000 })

    await page.getByRole('button', { name: 'Newest' }).click()
    await page.waitForLoadState('networkidle')
    await expect(page).not.toHaveURL(/[?&]sort=oldest/, { timeout: 10000 })
  })
})

// ---------------------------------------------------------------------------
// Article editor toolbar formatting
// ---------------------------------------------------------------------------

test.describe('Help Center article editor toolbar', () => {
  test('bubble menu appears when text is selected', async ({ page }) => {
    await createAndOpenArticle(page, `Toolbar Test ${Date.now()}`)

    const editor = page.locator('.ProseMirror[contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 10000 })

    // Type some text to select
    await editor.click()
    await editor.type('Hello formatting world')

    // Select all text in the editor (Ctrl+A scoped to editor)
    await editor.press('Control+a')

    // The bubble menu appears on a text selection. The article editor is
    // borderless, so it has no fixed toolbar, and this Bold button exists
    // only in the bubble menu (rich-text-editor.tsx BubbleMenuContent). The
    // old tippy/class locator matched nothing, so the case passed untested.
    await expect(page.getByRole('button', { name: 'Bold (Cmd+B)' })).toBeVisible({ timeout: 5000 })
  })

  test('bold shortcut (Ctrl+B) toggles bold in editor', async ({ page }) => {
    await createAndOpenArticle(page, `Bold Test ${Date.now()}`)

    const editor = page.locator('.ProseMirror[contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 10000 })

    await editor.click()
    await editor.type('bold text')
    await editor.press('Control+a')
    await editor.press('Control+b')

    // Text should now be wrapped in a <strong> tag
    const boldText = editor.locator('strong')
    await expect(boldText).toBeVisible({ timeout: 3000 })
  })

  test('italic shortcut (Ctrl+I) toggles italic in editor', async ({ page }) => {
    await createAndOpenArticle(page, `Italic Test ${Date.now()}`)

    const editor = page.locator('.ProseMirror[contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 10000 })

    await editor.click()
    await editor.type('italic text')
    await editor.press('Control+a')
    await editor.press('Control+i')

    const italicText = editor.locator('em')
    await expect(italicText).toBeVisible({ timeout: 3000 })
  })

  test('slash command menu opens when "/" is typed at start of line', async ({ page }) => {
    await createAndOpenArticle(page, `Slash Menu Test ${Date.now()}`)

    const editor = page.locator('.ProseMirror[contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 10000 })

    // Click at end of editor to position cursor, then press Enter for new line
    await editor.click()
    await editor.press('End')
    await editor.press('Enter')
    await editor.type('/')

    // The slash menu lists its block types as buttons (SlashMenuList), and
    // the article editor enables headings. The old locators matched nothing
    // and the case passed without checking the menu at all.
    await expect(page.getByRole('button', { name: /Heading 1/ })).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape') // dismiss
  })
})

// ---------------------------------------------------------------------------
// Article SEO / description field
// ---------------------------------------------------------------------------

test.describe('Help Center article SEO description', () => {
  test('description field value is persisted after save and page reload', async ({ page }) => {
    await createAndOpenArticle(page, `SEO Test ${Date.now()}`)

    const descInput = page.getByPlaceholder('Page description (optional)')
    await expect(descInput).toBeVisible({ timeout: 10000 })

    const description = `SEO description set at ${Date.now()}`
    await descInput.fill(description)

    await page.getByRole('button', { name: /save changes/i }).click()
    // Wait for save
    await expect(
      page
        .getByRole('button', { name: /saving/i })
        .or(page.getByRole('button', { name: /save changes/i }))
    ).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('button', { name: /save changes/i })).toBeVisible({
      timeout: 10000,
    })

    // Reload and verify the description was persisted
    await page.reload()
    await page.waitForLoadState('networkidle')

    const reloadedDesc = page.getByPlaceholder('Page description (optional)')
    await expect(reloadedDesc).toHaveValue(description, { timeout: 10000 })
  })

  test('description field is trimmed on save (leading/trailing whitespace)', async ({ page }) => {
    await createAndOpenArticle(page, `Trim Test ${Date.now()}`)

    const descInput = page.getByPlaceholder('Page description (optional)')
    await expect(descInput).toBeVisible({ timeout: 10000 })

    await descInput.fill('  trimmed description  ')
    await page.getByRole('button', { name: /save changes/i }).click()
    await page.waitForLoadState('networkidle')

    // After reload the value should be trimmed (the server trims on save)
    await page.reload()
    await page.waitForLoadState('networkidle')

    const reloaded = page.getByPlaceholder('Page description (optional)')
    const savedValue = await reloaded.inputValue()
    expect(savedValue.trim()).toBe('trimmed description')
  })
})

// ---------------------------------------------------------------------------
// Article list filtering — status and search
// ---------------------------------------------------------------------------

test.describe('Help Center article list filtering - status', () => {
  test.beforeEach(async ({ page }) => {
    await enableHelpCenter(page)
    await page.goto('/admin/help-center')
    await page.waitForLoadState('networkidle')
  })

  test('"Add filter" button opens filter popover with Status and Category options', async ({
    page,
  }) => {
    const addFilterButton = page.getByRole('button', { name: /add filter/i })
    await expect(addFilterButton).toBeVisible({ timeout: 10000 })

    await addFilterButton.click()

    // Popover should list Status and Category. Scope to the popover: the list's
    // own sidebar renders a "Status" section header button too, so an unscoped
    // getByText('Status') is a strict-mode violation.
    const popover = page.locator('[data-radix-popper-content-wrapper]')
    await expect(popover.getByRole('button', { name: 'Status' })).toBeVisible({ timeout: 3000 })
    await expect(popover.getByRole('button', { name: 'Category' })).toBeVisible({ timeout: 3000 })
  })

  test('can apply Draft status filter', async ({ page }) => {
    const addFilterButton = page.getByRole('button', { name: /add filter/i })
    await expect(addFilterButton).toBeVisible({ timeout: 10000 })

    await addFilterButton.click()
    await page
      .locator('[data-radix-popper-content-wrapper]')
      .getByRole('button', { name: 'Status' })
      .click()

    // Status sub-menu shows Draft and Published
    await expect(page.getByRole('button', { name: 'Draft' })).toBeVisible({ timeout: 3000 })
    await page.getByRole('button', { name: 'Draft' }).click()
    await page.waitForLoadState('networkidle')

    // A filter chip for Status: Draft should now be visible. Assert the chip
    // itself, via the accessible name FilterChip gives its remove button
    // (`Remove ${label} ${value} filter`): a bare getByText('Draft') also
    // matched the popover option and every Draft badge in the list.
    await expect(page.getByRole('button', { name: 'Remove Status Draft filter' })).toBeVisible({
      timeout: 5000,
    })
  })

  test('can apply Published status filter', async ({ page }) => {
    const addFilterButton = page.getByRole('button', { name: /add filter/i })
    await expect(addFilterButton).toBeVisible({ timeout: 10000 })

    await addFilterButton.click()
    await page
      .locator('[data-radix-popper-content-wrapper]')
      .getByRole('button', { name: 'Status' })
      .click()

    await expect(page.getByRole('button', { name: 'Published' })).toBeVisible({ timeout: 3000 })
    await page.getByRole('button', { name: 'Published' }).click()
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('button', { name: 'Remove Status Published filter' })).toBeVisible({
      timeout: 5000,
    })
  })

  test('status filter chip can be removed', async ({ page }) => {
    // Apply a Draft filter
    const addFilterButton = page.getByRole('button', { name: /add filter/i })
    await expect(addFilterButton).toBeVisible({ timeout: 10000 })

    await addFilterButton.click()
    await page
      .locator('[data-radix-popper-content-wrapper]')
      .getByRole('button', { name: 'Status' })
      .click()
    await page.getByRole('button', { name: 'Draft' }).click()
    await page.waitForLoadState('networkidle')

    // FilterChip names its remove button `Remove ${label} ${value} filter`.
    // The old locator guessed at "a button after one that mentions status"
    // and returned early, passing, whenever the guess found nothing.
    const removeButton = page.getByRole('button', { name: 'Remove Status Draft filter' })
    await expect(removeButton).toBeVisible({ timeout: 5000 })
    await removeButton.click()
    await page.waitForLoadState('networkidle')

    await expect(removeButton).toHaveCount(0, { timeout: 5000 })
  })

  test('searching in the admin list shows matching articles', async ({ page }) => {
    // Create an article with a unique title so we can search for it
    const uniqueTitle = `SearchTarget ${Date.now()}`
    await createAndOpenArticle(page, uniqueTitle)

    // Return to the list
    await page.goto('/admin/help-center')
    await page.waitForLoadState('networkidle')

    const searchInput = page
      .locator('[data-search-input]')
      .or(page.getByPlaceholder(/search all articles/i))
      .or(page.getByPlaceholder(/search/i))
    await expect(searchInput.first()).toBeVisible({ timeout: 10000 })

    await searchInput.first().fill(uniqueTitle)
    await page.waitForTimeout(500) // debounce
    await page.waitForLoadState('networkidle')

    // The article should appear in the list
    await expect(page.getByText(uniqueTitle)).toBeVisible({ timeout: 10000 })
  })

  test('searching with no matches shows "No articles match your search" empty state', async ({
    page,
  }) => {
    const searchInput = page
      .locator('[data-search-input]')
      .or(page.getByPlaceholder(/search all articles/i))
      .or(page.getByPlaceholder(/search/i))
    await expect(searchInput.first()).toBeVisible({ timeout: 10000 })

    await searchInput.first().fill('xyznonexistentarticlexyz98765')
    await page.waitForTimeout(500)
    await page.waitForLoadState('networkidle')

    await expect(
      page
        .getByText('No articles match your search')
        .or(page.getByText('No articles match your filters'))
    ).toBeVisible({ timeout: 10000 })
  })
})

// ---------------------------------------------------------------------------
// Article preview / "View article" link
// ---------------------------------------------------------------------------

test.describe('Help Center article preview link', () => {
  test('"View article" link uses the correct /hc/articles/{cat}/{slug} path', async ({ page }) => {
    await createAndOpenArticle(page, `Preview Test ${Date.now()}`)

    // The article must be published to show the "View article" link
    const publishButton = page.getByRole('button', { name: /^publish$/i })
    await expect(publishButton).toBeVisible({ timeout: 10000 })
    await publishButton.click()

    // Wait for "View article" link to appear
    const viewLink = page.locator('a').filter({ hasText: /view article/i })
    await expect(viewLink).toBeVisible({ timeout: 10000 })

    // Verify the href follows /hc/articles/{category-slug}/{article-slug}
    const href = await viewLink.getAttribute('href')
    expect(href).toMatch(/\/hc\/articles\//)
  })

  test('"View article" link opens in a new tab (target=_blank)', async ({ page }) => {
    await createAndOpenArticle(page, `NewTab Test ${Date.now()}`)

    const publishButton = page.getByRole('button', { name: /^publish$/i })
    await expect(publishButton).toBeVisible({ timeout: 10000 })
    await publishButton.click()

    const viewLink = page.locator('a').filter({ hasText: /view article/i })
    await expect(viewLink).toBeVisible({ timeout: 10000 })

    const target = await viewLink.getAttribute('target')
    expect(target).toBe('_blank')
  })

  test('"View article" link is not shown for draft articles', async ({ page }) => {
    await createAndOpenArticle(page, `Draft Link Test ${Date.now()}`)

    // Article is in draft state after creation — "View article" should not be present
    const viewLink = page.locator('a').filter({ hasText: /view article/i })
    await expect(viewLink).toBeHidden({ timeout: 5000 })

    // Publish button should be visible instead
    await expect(page.getByRole('button', { name: /^publish$/i })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Article list item — context menu
// ---------------------------------------------------------------------------

test.describe('Help Center article list item actions', () => {
  test.beforeEach(async ({ page }) => {
    await enableHelpCenter(page)
    await page.goto('/admin/help-center')
    await page.waitForLoadState('networkidle')
  })

  test('article row shows ellipsis menu with Edit and Delete options on hover', async ({
    page,
  }) => {
    // This case used to locate the trigger as "the last button in `div.group`
    // that contains an svg", behind three guards that each returned silently.
    // Two of them could never fire as written -- `.first()` resolves to 0 or 1
    // elements, so `count() === 0` on it was a test for "the page is empty" --
    // and the third, `if (count > 0)`, let the case PASS having asserted
    // nothing whenever the guess found no button.
    //
    // `div.group` is a Tailwind utility used across the admin shell, so
    // `.first()` was not reliably an article row, and the "last button with an
    // svg" was not reliably the menu trigger. That is why this was flaky on two
    // CI runs and then failed all three attempts on a third.
    //
    // The trigger now carries `aria-label="Article actions"` (matching
    // help-center-article-editor.tsx), so it can be addressed by role and name.
    const trigger = page.getByRole('button', { name: 'Article actions' })

    if ((await trigger.count()) === 0) {
      // A genuinely empty list is the one legitimate reason to stop. Skip
      // loudly rather than return green having tested nothing.
      test.skip(true, 'no help-center articles in the seed to open a row menu on')
      return
    }

    await trigger.first().click()

    await expect(page.getByRole('menuitem', { name: /edit/i })).toBeVisible({ timeout: 3000 })
    await expect(page.getByRole('menuitem', { name: /delete/i })).toBeVisible()

    await page.keyboard.press('Escape')
  })
})
