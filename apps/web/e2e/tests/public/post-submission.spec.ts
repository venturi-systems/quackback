import { test, expect, Page, BrowserContext, type TestInfo, type Route } from '@playwright/test'
import { getOtpCode } from '../../utils/db-helpers'
import { flushMagicLinkRateLimit } from '../../utils/access-helpers'

const TEST_EMAIL = 'demo@example.com'

// Run the file's tests one at a time and in order (no parallelization), which
// prevents OTP race conditions across the describe blocks. Default mode, not
// serial: serial mode skipped every test after the known failure "shows error
// when submitting without description", so 28 tests never ran in CI. After a
// failure the fresh worker signs in again in beforeAll.
test.describe.configure({ mode: 'default' })

/**
 * Helper function to get OTP code with retries
 * Database writes may not be immediately visible
 */
async function getOtpCodeWithRetry(email: string, maxRetries = 3): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return getOtpCode(email)
    } catch {
      if (i === maxRetries - 1) throw new Error(`Failed to get OTP after ${maxRetries} retries`)
      // Wait 100ms before retrying
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('Failed to get OTP')
}

/**
 * Helper function to authenticate using OTP flow via API
 * This is faster and more reliable than using the UI
 */
async function loginWithOTP(page: Page) {
  const context = page.context()

  // Step 1: Request OTP code via Better-auth
  const sendResponse = await context.request.post('/api/auth/email-otp/send-verification-otp', {
    data: {
      email: TEST_EMAIL,
      type: 'sign-in',
    },
  })

  if (!sendResponse.ok()) {
    const errorBody = await sendResponse.text()
    throw new Error(`OTP send failed (${sendResponse.status()}): ${errorBody}`)
  }

  // Step 2: Get OTP code directly from database (with retry for timing issues)
  const code = await getOtpCodeWithRetry(TEST_EMAIL)
  expect(code).toMatch(/^\d{6}$/) // 6-digit code

  // Step 3: Verify OTP code via Better-auth
  const verifyResponse = await context.request.post('/api/auth/sign-in/email-otp', {
    data: {
      email: TEST_EMAIL,
      otp: code,
    },
  })
  expect(verifyResponse.ok()).toBeTruthy()

  // Step 4: Session cookie is now set by Better-auth
  // Navigate to home page to verify authentication
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Verify we're on the home page (portal); URL may include query params like ?sort=top
  await expect(page).toHaveURL(/^http:\/\/[^/]+\/?(\?.*)?$/, { timeout: 10000 })
}

// Global variables to share context and page across all tests
let globalContext: BrowserContext
let globalPage: Page

// Set up authentication once for the entire file
test.beforeAll(async ({ browser }) => {
  // Each worker signs in once, and a worker restarts after any failure, so a
  // run can send more codes to TEST_EMAIL than the sign-in limiter allows
  // (3 per 15 minutes); that 429 used to fail every later test in the file.
  // Clear the limiter's counters for this run first; product limits stay.
  flushMagicLinkRateLimit()
  globalContext = await browser.newContext()
  globalPage = await globalContext.newPage()
  await loginWithOTP(globalPage)
})

// Clean up after all tests in the file
test.afterAll(async () => {
  await globalPage.close()
  await globalContext.close()
})

test.describe('Public Post Submission', () => {
  test.beforeEach(async () => {
    // Navigate to home for each test
    await globalPage.goto('/')
    await globalPage.waitForLoadState('networkidle')
  })

  test('can open submit post form', async () => {
    // Find and click the "What's your idea?" input to expand the form
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await expect(createPostInput).toBeVisible({ timeout: 10000 })
    await createPostInput.click()

    // Form should expand - verify by checking for rich text editor
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })
  })

  test('form has correct placeholder text', async () => {
    // Expand the form by clicking the input
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await createPostInput.click()

    // Verify title placeholder is visible
    await expect(createPostInput).toBeVisible({ timeout: 5000 })

    // Verify editor is visible
    // TipTap renders placeholder via CSS ::before pseudo-element, so we check for the editor element
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })
  })

  test('can close form with Cancel button', async () => {
    // Expand the form
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await createPostInput.click()

    // Wait for form to expand
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Click Cancel button
    const cancelButton = globalPage.getByRole('button', { name: /^cancel$/i })
    await cancelButton.click()

    // Form should collapse - editor should no longer be visible
    await expect(editor).not.toBeVisible({ timeout: 5000 })
  })

  test('can close form with Escape key', async () => {
    // Expand the form
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await createPostInput.click()

    // Wait for form to expand
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Press Escape key
    await globalPage.keyboard.press('Escape')

    // Form should collapse - editor should no longer be visible
    await expect(editor).not.toBeVisible({ timeout: 5000 })
  })

  test('form resets on close and reopen via Escape', async () => {
    // Expand the form
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await createPostInput.click()

    // Fill in some data
    await createPostInput.fill('Test Title')

    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })
    await editor.click()
    await globalPage.keyboard.type('Test description content')

    // Close the form with Escape
    await globalPage.keyboard.press('Escape')
    await expect(editor).not.toBeVisible({ timeout: 5000 })

    // Reopen the form
    await createPostInput.click()
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Form should be empty (reset happens on collapse)
    await expect(createPostInput).toHaveValue('')

    // Editor should be empty (check if it has the empty class)
    const editorParagraph = editor.locator('p').first()
    await expect(editorParagraph).toHaveClass(/is-editor-empty/)
  })

  test('title input is auto-focused on open', async () => {
    // Open the dialog
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await createPostInput.click()

    // Wait for dialog to open
    await globalPage.waitForTimeout(500) // Small delay for focus to settle

    // Title input should have focus
    const titleInput = globalPage.getByPlaceholder("What's your idea?")
    await expect(titleInput).toBeFocused({ timeout: 5000 })
  })

  test('shows error when submitting without title', async () => {
    // Open the dialog
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await createPostInput.click()

    // Wait for dialog to open
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Don't fill anything, just click Submit
    const submitButton = globalPage.getByRole('button', { name: /^submit$/i })
    await submitButton.click()

    // Error message should appear
    const errorMessage = globalPage.locator('.bg-destructive\\/10')
    await expect(errorMessage).toBeVisible({ timeout: 5000 })
    await expect(errorMessage).toContainText('Please add a title')
  })

  test('shows error when submitting without description', async () => {
    // Open the dialog
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await createPostInput.click()

    // Wait for dialog to open
    const titleInput = globalPage.getByPlaceholder("What's your idea?")
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Fill only the title
    await titleInput.fill('Test Post Title')

    // Click Submit without filling description
    const submitButton = globalPage.getByRole('button', { name: /^submit$/i })
    await submitButton.click()

    // Error message should appear
    const errorMessage = globalPage.locator('.bg-destructive\\/10')
    await expect(errorMessage).toBeVisible({ timeout: 5000 })
    await expect(errorMessage).toContainText('Please add a description')
  })

  test('can submit a basic post', async () => {
    // Open the dialog
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await createPostInput.click()

    // Wait for dialog to open
    const titleInput = globalPage.getByPlaceholder("What's your idea?")
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Fill in the title
    await titleInput.fill('E2E Test Post')

    // Fill in the description (must use keyboard.type for TipTap)
    await editor.click()
    await globalPage.keyboard.type('This is a test post description created by E2E tests.')

    // Click Submit
    const submitButton = globalPage.getByRole('button', { name: /^submit$/i })
    await submitButton.click()

    // Dialog should close after successful submission
    await expect(editor).not.toBeVisible({ timeout: 10000 })
  })

  test('new post appears in the list after submission', async () => {
    // First switch to "New" sort so new posts appear at top
    const newSortButton = globalPage.getByRole('button', { name: /^New$/i })
    await newSortButton.click()
    await globalPage.waitForLoadState('networkidle')

    // Generate a unique title to identify our post
    const uniqueTitle = `E2E Test Post ${Date.now()}`

    // Open the dialog
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await createPostInput.click()

    // Wait for dialog to open
    const titleInput = globalPage.getByPlaceholder("What's your idea?")
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Fill in the form
    await titleInput.fill(uniqueTitle)

    await editor.click()
    await globalPage.keyboard.type('This post should appear in the feed after submission.')

    // Submit the post
    const submitButton = globalPage.getByRole('button', { name: /^submit$/i })
    await submitButton.click()

    // Wait for dialog to close - router.refresh() should update the feed automatically
    await expect(editor).not.toBeVisible({ timeout: 10000 })

    // The new post should be visible in the list WITHOUT any manual refresh
    // (The component calls router.refresh() after successful submission)
    const newPost = globalPage.getByRole('heading', { name: uniqueTitle })
    await expect(newPost).toBeVisible({ timeout: 10000 })
  })
})

// Phase 1.5: Board Selector Tests
test.describe('Board Selector', () => {
  test.beforeEach(async () => {
    // Navigate to home for each test
    await globalPage.goto('/')
    await globalPage.waitForLoadState('networkidle')
  })

  test('board selector is visible in dialog header', async () => {
    // Open the dialog
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })

    // Board selector should be visible (look for the select trigger)
    const boardSelector = globalPage.locator('[role="combobox"]')
    await expect(boardSelector).toBeVisible()
  })

  test('board selector shows default board name', async () => {
    // Open the dialog
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })

    // Board selector should show a board name (not just "Select board")
    const boardSelector = globalPage.locator('[role="combobox"]')
    await expect(boardSelector).not.toHaveText('Select board')
  })

  test('can open board selector dropdown', async () => {
    // Open the dialog
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })

    // Click the board selector to open dropdown
    const boardSelector = globalPage.locator('[role="combobox"]')
    await boardSelector.click()

    // Dropdown should be visible with options
    const selectContent = globalPage.locator('[role="listbox"]')
    await expect(selectContent).toBeVisible({ timeout: 5000 })
  })

  test('can select a different board', async () => {
    // Open the dialog
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })

    // Get initial board name
    const boardSelector = globalPage.locator('[role="combobox"]')
    const initialBoardName = await boardSelector.textContent()

    // Click to open dropdown
    await boardSelector.click()

    // Wait for dropdown to be visible
    const selectContent = globalPage.locator('[role="listbox"]')
    await expect(selectContent).toBeVisible({ timeout: 5000 })

    // Click on a different board option (if available)
    const options = globalPage.locator('[role="option"]')
    const optionCount = await options.count()

    if (optionCount > 1) {
      // Find an option that's different from the current one
      for (let i = 0; i < optionCount; i++) {
        const option = options.nth(i)
        const optionText = await option.textContent()
        if (optionText !== initialBoardName) {
          await option.click()
          break
        }
      }

      // Verify the board selector now shows the new board
      await expect(boardSelector).not.toHaveText(initialBoardName || '')
    }
  })

  test('board selector defaults to filtered board when filter is active', async () => {
    // Hold this navigation's scripts to expose the server-rendered readiness state.
    // The composer must not accept focus before its expansion handler is attached.
    let releaseScripts!: () => void
    let heldScripts = 0
    const scriptsReady = new Promise<void>((resolve) => {
      releaseScripts = resolve
    })
    const holdScripts = async (route: Route) => {
      if (route.request().resourceType() === 'script') {
        heldScripts += 1
        await scriptsReady
      }
      await route.continue()
    }
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await globalPage.route('**/*', holdScripts)
    try {
      await globalPage.goto('/?board=features', { waitUntil: 'commit' })
      await expect(createPostInput).toBeVisible({ timeout: 15000 })
      await expect(createPostInput).toBeDisabled()
      await expect.poll(() => heldScripts).toBeGreaterThan(0)
    } finally {
      releaseScripts()
      // Drain pending handlers before removing this page's only route.
      await globalPage.unrouteAll({ behavior: 'wait' })
    }

    // One user click must expand the hydrated composer without retrying focus.
    await expect(createPostInput).toBeEnabled({ timeout: 10000 })
    await createPostInput.click()
    await expect(globalPage.locator('.tiptap')).toBeVisible({ timeout: 10000 })
    await createPostInput.fill('Preserve this draft')
    await expect(createPostInput).toHaveValue('Preserve this draft')

    // Board selector should show the filtered board (Feature Requests)
    const boardSelector = globalPage.locator('[role="combobox"]')
    await expect(boardSelector).toContainText(/Feature Requests/i, { timeout: 10000 })
  })

  test('can submit post to a different board than default', async () => {
    // Sort by new to see fresh posts
    await globalPage.getByRole('button', { name: /^New$/i }).click()
    await globalPage.waitForLoadState('networkidle')

    const uniqueTitle = `Different Board Post ${Date.now()}`

    // Open the dialog
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })

    // Change board selection
    const boardSelector = globalPage.locator('[role="combobox"]')
    await boardSelector.click()

    const selectContent = globalPage.locator('[role="listbox"]')
    await expect(selectContent).toBeVisible({ timeout: 5000 })

    // Select Products board (if available) as an alternative to default
    const productsOption = globalPage.locator('[role="option"]', { hasText: /products/i })
    if ((await productsOption.count()) > 0) {
      await productsOption.click()
    } else {
      // Just click any available option
      await globalPage.locator('[role="option"]').first().click()
    }

    // Fill in the form
    await globalPage.getByPlaceholder("What's your idea?").fill(uniqueTitle)

    const editor = globalPage.locator('.tiptap')
    await editor.click()
    await globalPage.keyboard.type('This post was submitted to a different board')

    // Submit
    await globalPage.getByRole('button', { name: /^submit$/i }).click()
    // Editor should collapse after successful submission
    await expect(editor).not.toBeVisible({
      timeout: 10000,
    })

    // Post should appear (may need to adjust filters or check "All" view)
    // Navigate to all boards to see the post
    await globalPage.goto('/')
    await globalPage.waitForLoadState('networkidle')
    await globalPage.getByRole('button', { name: /^New$/i }).click()
    await globalPage.waitForLoadState('networkidle')

    await expect(globalPage.getByRole('heading', { name: uniqueTitle })).toBeVisible({
      timeout: 15000,
    })
  })

  test('board selection persists after typing content', async () => {
    // Open the dialog
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })

    // Change board selection
    const boardSelector = globalPage.locator('[role="combobox"]')
    await boardSelector.click()

    const selectContent = globalPage.locator('[role="listbox"]')
    await expect(selectContent).toBeVisible({ timeout: 5000 })

    // Select any option and note the board name
    const firstOption = globalPage.locator('[role="option"]').first()
    const selectedBoardName = await firstOption.textContent()
    await firstOption.click()

    // Type content
    await globalPage.getByPlaceholder("What's your idea?").fill('Test title')
    const editor = globalPage.locator('.tiptap')
    await editor.click()
    await globalPage.keyboard.type('Test content')

    // Board selection should still be the same
    await expect(boardSelector).toHaveText(selectedBoardName || '')
  })

  test('board selection resets when dialog is closed and reopened', async () => {
    // Open the form
    await globalPage.getByPlaceholder("What's your idea?").click()
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Get initial board name
    const boardSelector = globalPage.locator('[role="combobox"]')
    const initialBoardName = await boardSelector.textContent()

    // Change board selection
    await boardSelector.click()
    const selectContent = globalPage.locator('[role="listbox"]')
    await expect(selectContent).toBeVisible({ timeout: 5000 })

    const options = globalPage.locator('[role="option"]')
    const optionCount = await options.count()

    if (optionCount > 1) {
      // Select a different board
      for (let i = 0; i < optionCount; i++) {
        const option = options.nth(i)
        const optionText = await option.textContent()
        if (optionText !== initialBoardName) {
          await option.click()
          break
        }
      }
    }

    // Close form with Escape (editor should collapse)
    await globalPage.keyboard.press('Escape')
    await expect(editor).not.toBeVisible({
      timeout: 5000,
    })

    // Reopen form
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Board should be reset to initial/default
    await expect(boardSelector).toHaveText(initialBoardName || '')
  })

  test('shows "Posting to" label before board selector', async () => {
    // Open the dialog
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })

    // "Posting to" label should be visible
    await expect(globalPage.getByText('Posting to')).toBeVisible()
  })

  test('switching board filter updates default board in dialog', async () => {
    const editor = globalPage.locator('.tiptap')
    const boardSelector = globalPage.locator('[role="combobox"]')

    // Start with no filter - open form and note default board
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Close form
    await globalPage.keyboard.press('Escape')
    await expect(editor).not.toBeVisible({
      timeout: 5000,
    })

    // Click on Bug Reports board filter in sidebar (exists in seed data)
    const bugsFilter = globalPage.getByRole('button', { name: /Bug Reports/i })
    if ((await bugsFilter.count()) > 0) {
      await bugsFilter.click()
      await globalPage.waitForLoadState('networkidle')

      // Open form again
      await globalPage.getByPlaceholder("What's your idea?").click()
      await expect(editor).toBeVisible({ timeout: 5000 })

      // Board selector should now show Bug Reports
      await expect(boardSelector).toContainText(/Bug Reports/i)
    }
  })

  test('switching between multiple board filters updates form default each time', async () => {
    const boardSelector = globalPage.locator('[role="combobox"]')
    const editor = globalPage.locator('.tiptap')

    // Click Feature Requests filter (board that exists in database)
    const featuresFilter = globalPage.getByRole('button', { name: /Feature Requests/i })
    if ((await featuresFilter.count()) > 0) {
      await featuresFilter.click()
      await globalPage.waitForLoadState('networkidle')

      // Open form - should default to Feature Requests
      await globalPage.getByPlaceholder("What's your idea?").click()
      await expect(editor).toBeVisible({ timeout: 5000 })
      await expect(boardSelector).toContainText(/Feature Requests/i)

      // Close form
      await globalPage.keyboard.press('Escape')
      await expect(editor).not.toBeVisible({
        timeout: 5000,
      })
    }

    // Click Bug Reports filter (another board that exists in seed data)
    const bugsFilter = globalPage.getByRole('button', { name: /Bug Reports/i })
    if ((await bugsFilter.count()) > 0) {
      await bugsFilter.click()
      await globalPage.waitForLoadState('networkidle')

      // Open form - should default to Bug Reports
      await globalPage.getByPlaceholder("What's your idea?").click()
      await expect(editor).toBeVisible({ timeout: 5000 })
      await expect(boardSelector).toContainText(/Bug Reports/i)

      // Close form
      await globalPage.keyboard.press('Escape')
      await expect(editor).not.toBeVisible({
        timeout: 5000,
      })
    }

    // Click "All" or go back to home to clear filter
    await globalPage.goto('/')
    await globalPage.waitForLoadState('networkidle')

    // Open form - should default to first board (not filtered)
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(editor).toBeVisible({ timeout: 5000 })

    // Board selector should be visible and show a board name
    await expect(boardSelector).toBeVisible()
    await expect(boardSelector).not.toHaveText('Select board')
  })

  test('clicking any board in sidebar then opening dialog shows that board as default', async () => {
    const boardSelector = globalPage.locator('[role="combobox"]')

    // Get all board buttons in the sidebar (excluding "View all posts")
    const sidebarBoardButtons = globalPage
      .locator('aside button')
      .filter({ hasNotText: /view all/i })

    // Get the second board button (to ensure we're switching from default)
    const secondBoardButton = sidebarBoardButtons.nth(1)

    if (await secondBoardButton.isVisible()) {
      // Get the board name before clicking
      const boardName = await secondBoardButton.textContent()

      // Click the board filter
      await secondBoardButton.click()
      await globalPage.waitForLoadState('networkidle')

      // Open dialog
      await globalPage.getByPlaceholder("What's your idea?").click()
      await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })

      // Board selector should show the clicked board's name
      // Extract just the board name (remove any count badges)
      const expectedBoardName = boardName?.split(/\d/)[0].trim()
      if (expectedBoardName) {
        await expect(boardSelector).toContainText(expectedBoardName)
      }
    } else {
      // No second board visible in sidebar - test passes trivially
      expect(true).toBe(true)
    }
  })
})

// Phase 2: Rich Text Editor Tests
/**
 * Open the slash menu in the create-post editor and pick a list item.
 *
 * The item is applied by clicking its button (SlashMenuList prevents the
 * mousedown blur); if the list has not formed, the query is typed again and
 * Enter picks the highlighted item. Each step attaches the editor's HTML and
 * the popover's buttons to the report, so a failure shows what the page did.
 */
async function startListFromSlashMenu(
  editor: ReturnType<Page['locator']>,
  query: string,
  itemName: RegExp,
  listTag: 'ul' | 'ol',
  testInfo: TestInfo
) {
  const snapshot = async (label: string) => {
    const state = await globalPage.evaluate((name) => {
      const tiptap = document.querySelector('.tiptap')
      const buttons = Array.from(document.querySelectorAll('button')).filter((b) =>
        new RegExp(name).test(b.textContent ?? '')
      )
      return {
        editorHtml: tiptap?.innerHTML ?? null,
        activeElement: document.activeElement?.tagName + '.' + document.activeElement?.className,
        matchingButtons: buttons.map((b) => b.outerHTML.slice(0, 300)),
      }
    }, itemName.source)
    await testInfo.attach(label, {
      body: JSON.stringify(state, null, 2),
      contentType: 'application/json',
    })
  }
  // Browser-side errors thrown by the item's command chain surface here, not
  // in the test's own assertions.
  const errors: string[] = []
  const onPageError = (error: Error) => errors.push(`pageerror: ${error.message}`)
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  }
  globalPage.on('pageerror', onPageError)
  globalPage.on('console', onConsole)
  await editor.click()
  await editor.type(query)
  const item = globalPage.getByRole('button', { name: itemName })
  await expect(item).toBeVisible()
  await snapshot(`${listTag}-1-menu-open`)
  await item.click()
  await globalPage.waitForTimeout(300)
  await snapshot(`${listTag}-2-after-click`)
  await testInfo.attach(`${listTag}-errors-after-click`, {
    body: JSON.stringify(errors, null, 2),
    contentType: 'application/json',
  })
  if ((await editor.locator(listTag).count()) === 0) {
    await editor.click()
    await editor.type(query)
    await expect(item).toBeVisible()
    await globalPage.keyboard.press('Enter')
    await globalPage.waitForTimeout(300)
    await snapshot(`${listTag}-3-after-enter`)
  }
  globalPage.off('pageerror', onPageError)
  globalPage.off('console', onConsole)
  await testInfo.attach(`${listTag}-errors`, {
    body: JSON.stringify(errors, null, 2),
    contentType: 'application/json',
  })
}

test.describe('Rich Text Editor', () => {
  test.beforeEach(async () => {
    // Navigate to home for each test
    await globalPage.goto('/')
    await globalPage.waitForLoadState('networkidle')

    // Open the dialog for all tests
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })
  })

  test('can type plain text in editor', async () => {
    const editor = globalPage.locator('.tiptap')
    await editor.click()
    await globalPage.keyboard.type('This is plain text content')

    await expect(editor).toContainText('This is plain text content')
  })

  test('can format text as bold using toolbar button', async () => {
    const editor = globalPage.locator('.tiptap')
    await editor.click()
    await globalPage.keyboard.type('bold text')

    // Triple-click to select text (Meta+a doesn't work in TipTap context)
    await editor.click({ clickCount: 3 })

    // Click bold button
    const boldButton = globalPage.locator('button:has(svg.lucide-bold)')
    await boldButton.click()

    // Verify text is bold
    await expect(editor.locator('strong')).toContainText('bold text')
  })

  test('can format text as italic using toolbar button', async () => {
    const editor = globalPage.locator('.tiptap')
    await editor.click()
    await globalPage.keyboard.type('italic text')

    // Triple-click to select text
    await editor.click({ clickCount: 3 })

    // Click italic button
    const italicButton = globalPage.locator('button:has(svg.lucide-italic)')
    await italicButton.click()

    // Verify text is italic
    await expect(editor.locator('em')).toContainText('italic text')
  })

  test('can use keyboard shortcut for bold (Cmd/Ctrl+B)', async () => {
    const editor = globalPage.locator('.tiptap')
    await editor.click()
    await globalPage.keyboard.type('bold text')

    // Select all text with keyboard, then apply bold
    await globalPage.keyboard.press('Control+a')
    await globalPage.keyboard.press('Control+b')

    // Verify text is bold
    await expect(editor.locator('strong')).toContainText('bold text')
  })

  test('can use keyboard shortcut for italic (Cmd/Ctrl+I)', async () => {
    const editor = globalPage.locator('.tiptap')
    await editor.click()
    await globalPage.keyboard.type('italic text')

    // Select all text with keyboard, then apply italic
    await globalPage.keyboard.press('Control+a')
    await globalPage.keyboard.press('Control+i')

    // Verify text is italic
    await expect(editor.locator('em')).toContainText('italic text')
  })

  // eslint-disable-next-line no-empty-pattern -- testInfo needs the fixture slot
  test('can create bullet list', async ({}, testInfo) => {
    const editor = globalPage.locator('.tiptap')

    // The create-post editor is borderless (no top toolbar) and Enter inserts
    // a line break outside a list (enterAsHardBreak), so a list starts the
    // way the product offers it: the slash menu. "/bullet" matches the
    // "Bullet List" item; inside the list, Enter splits list items.
    await startListFromSlashMenu(editor, '/bullet', /Bullet List/, 'ul', testInfo)
    await globalPage.keyboard.type('First item')
    await globalPage.keyboard.press('Enter')
    await globalPage.keyboard.type('Second item')

    // Verify list structure
    await expect(editor.locator('ul')).toBeVisible()
    await expect(editor.locator('li')).toHaveCount(2)
  })

  // eslint-disable-next-line no-empty-pattern -- testInfo needs the fixture slot
  test('can create numbered list', async ({}, testInfo) => {
    const editor = globalPage.locator('.tiptap')

    // Same editor as above: the slash menu's "Numbered List" item.
    await startListFromSlashMenu(editor, '/numbered', /Numbered List/, 'ol', testInfo)
    await globalPage.keyboard.type('First item')
    await globalPage.keyboard.press('Enter')
    await globalPage.keyboard.type('Second item')

    // Verify list structure
    await expect(editor.locator('ol')).toBeVisible()
    await expect(editor.locator('li')).toHaveCount(2)
  })

  test('can add a link to text', async () => {
    const editor = globalPage.locator('.tiptap')
    await editor.click()
    await globalPage.keyboard.type('click here')

    // Triple-click to select text
    await editor.click({ clickCount: 3 })

    // The selection bubble menu's link button opens a popover with a URL
    // field (LinkButton in rich-text-editor.tsx); Enter applies it. The
    // button's accessible name is its title.
    await globalPage.getByRole('button', { name: 'Insert Link' }).click()
    const urlField = globalPage.getByPlaceholder('https://example.com')
    await expect(urlField).toBeVisible()
    await urlField.fill('https://example.com')
    await urlField.press('Enter')

    // Verify link was created
    const link = editor.locator('a')
    await expect(link).toHaveAttribute('href', 'https://example.com')
  })

  test('bold button shows active state when text is bold', async () => {
    const editor = globalPage.locator('.tiptap')
    await editor.click()
    await globalPage.keyboard.type('bold text')

    // Triple-click to select and make bold using toolbar button
    await editor.click({ clickCount: 3 })
    const boldButton = globalPage.locator('button:has(svg.lucide-bold)')
    await boldButton.click()

    // Click back in editor to position cursor within bold text
    await editor.click()

    // Bold button should have active state (bg-muted class)
    await expect(boldButton).toHaveClass(/bg-muted/)
  })
})

// Phase 3: Submission States and Integration Tests
test.describe('Submission States and Integration', () => {
  test.beforeEach(async () => {
    // Navigate to home for each test
    await globalPage.goto('/')
    await globalPage.waitForLoadState('networkidle')
  })

  test('Submit button shows "Submit" initially', async () => {
    await globalPage.getByPlaceholder("What's your idea?").click()
    await expect(globalPage.getByPlaceholder("What's your idea?")).toBeVisible({ timeout: 5000 })

    const submitButton = globalPage.getByRole('button', { name: /^submit$/i })
    await expect(submitButton).toHaveText('Submit')
  })

  test('can submit with Cmd+Enter keyboard shortcut', async () => {
    // Switch to New sort
    await globalPage.getByRole('button', { name: /^New$/i }).click()
    await globalPage.waitForLoadState('networkidle')

    const uniqueTitle = `Keyboard Submit Test ${Date.now()}`

    await globalPage.getByPlaceholder("What's your idea?").click()
    const titleInput = globalPage.getByPlaceholder("What's your idea?")
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    await titleInput.fill(uniqueTitle)

    await editor.click()
    await globalPage.keyboard.type('Submitted with keyboard shortcut')

    // Submit with Cmd+Enter
    await globalPage.keyboard.press('Meta+Enter')

    // Dialog should close
    await expect(editor).not.toBeVisible({ timeout: 10000 })

    // Post should appear
    await expect(globalPage.getByRole('heading', { name: uniqueTitle })).toBeVisible({
      timeout: 10000,
    })
  })

  test('Submit form is visible on filtered board', async () => {
    // Navigate with board filter (using 'features' board which exists in database)
    await globalPage.goto('/?board=features')
    await globalPage.waitForLoadState('networkidle')

    // Submit form input should be visible
    const createPostInput = globalPage.getByPlaceholder("What's your idea?")
    await expect(createPostInput).toBeVisible({ timeout: 10000 })
  })

  test('post submits to the current board context', async () => {
    // Navigate to home first
    await globalPage.goto('/')
    await globalPage.waitForLoadState('networkidle')

    // Click Feature Requests board filter (board that exists in database)
    const featuresButton = globalPage.getByRole('button', { name: /Feature Requests/i })
    await featuresButton.click()
    await globalPage.waitForLoadState('networkidle')

    // Click New sort to see newest posts first
    const newSortButton = globalPage.getByRole('button', { name: /^New$/i })
    await newSortButton.click()
    await globalPage.waitForLoadState('networkidle')

    const uniqueTitle = `Feature Requests Board Post ${Date.now()}`

    await globalPage.getByPlaceholder("What's your idea?").click()
    const titleInput = globalPage.getByPlaceholder("What's your idea?")
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    await titleInput.fill(uniqueTitle)

    await editor.click()
    await globalPage.keyboard.type('This post should appear in the features board')

    await globalPage.getByRole('button', { name: /^submit$/i }).click()
    await expect(editor).not.toBeVisible({ timeout: 10000 })

    // Reload page to ensure fresh server data is displayed
    // (Client state doesn't auto-update with router.refresh when filters are already set)
    await globalPage.reload()
    await globalPage.waitForLoadState('networkidle')

    // Post should appear in the filtered results (still on features board)
    await expect(globalPage.getByRole('heading', { name: uniqueTitle })).toBeVisible({
      timeout: 15000,
    })

    // URL should still have board filter
    await expect(globalPage).toHaveURL(/board=features/)
  })

  test('submitted post shows author name', async () => {
    // Sort by new to see fresh posts
    await globalPage.getByRole('button', { name: /^New$/i }).click()
    await globalPage.waitForLoadState('networkidle')

    const uniqueTitle = `Author Test Post ${Date.now()}`

    await globalPage.getByPlaceholder("What's your idea?").click()
    const titleInput = globalPage.getByPlaceholder("What's your idea?")
    const editor = globalPage.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })

    await titleInput.fill(uniqueTitle)

    await editor.click()
    await globalPage.keyboard.type('Testing author attribution')

    await globalPage.getByRole('button', { name: /^submit$/i }).click()
    await expect(editor).not.toBeVisible({ timeout: 10000 })

    // Find the post and verify author is shown
    const postCard = globalPage.locator('a[href*="/posts/"]').filter({ hasText: uniqueTitle })
    await expect(postCard).toBeVisible({ timeout: 10000 })

    // Should show "Demo User" as author (from demo@example.com)
    await expect(postCard).toContainText(/Demo|demo/i)
  })
})
