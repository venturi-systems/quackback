import { createHash } from 'node:crypto'
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { getOtpCode } from '../../utils/db-helpers'
import { closeDialog } from '../../utils/helpers'

/**
 * Public portal auth tests with no prior authentication.
 *
 * The dialog starts with email entry, then selects the configured password or
 * email-link method. Email-link sends provide both a link and a six-digit code.
 * These tests exercise real endpoints in the suite's disposable environment;
 * the existing database helper reads only the code created by the current case.
 */

// Keep each case and retry independent without changing the product's rate limits.
function authTestEmail(testInfo: TestInfo): string {
  const suffix = createHash('sha256')
    .update([testInfo.testId, testInfo.retry, testInfo.repeatEachIndex].join(':'))
    .digest('hex')
    .slice(0, 16)
  return 'alex.morgan+' + suffix + '@acme.example'
}

async function enterEmail(page: Page, email: string): Promise<void> {
  const dialog = page.getByRole('dialog')
  const emailInput = dialog.locator('#inline-email')
  await expect(emailInput).toBeVisible()
  await emailInput.fill(email)
  await dialog.getByRole('button', { name: /^Continue\s*→$/ }).click()

  const selectedEmail = dialog.locator('#inline-email-locked')
  await expect(selectedEmail).toBeVisible()
  await expect(selectedEmail).toHaveValue(email)
  await expect(selectedEmail).toHaveAttribute('readonly', '')
}

async function requestEmailCode(page: Page, email: string): Promise<void> {
  await enterEmail(page, email)
  const dialog = page.getByRole('dialog')
  // The password-enabled fixture starts on credentials; an email-only fixture
  // starts directly on the email-link method after the same email-entry step.
  if ((await dialog.locator('#inline-password').count()) > 0) {
    await dialog
      .getByRole('button', { name: 'Email me a sign-in link instead', exact: true })
      .click()
  }

  const sendButton = dialog.getByRole('button', { name: 'Continue with email', exact: true })
  await expect(sendButton).toBeVisible()
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/auth/portal-signin' &&
        res.request().method() === 'POST',
      { timeout: 15000 }
    ),
    sendButton.click(),
  ])
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toMatchObject({ email })
  expect(await response.json()).toEqual({ ok: true })
  await expect(dialog.getByLabel('Verification code', { exact: true })).toBeVisible({
    timeout: 10000,
  })
}

test.describe('Portal Auth Dialog', () => {
  // One at a time and in order, without skipping the rest after a failure:
  // serial mode left the 16 tests after a known failure unrun on every CI run.
  test.describe.configure({ mode: 'default' })

  // CI owns authentication settings until the entire shard has finished.
  // Suite teardown must not consume the job's recovery snapshot.

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test.afterEach(async ({ page }) => {
    // Close any open dialog so state doesn't bleed into the next test.
    if ((await page.getByRole('dialog').count()) > 0) {
      await closeDialog(page).catch(() => {})
    }
  })

  // ---------------------------------------------------------------------------
  // Opening the dialog
  // ---------------------------------------------------------------------------

  test('clicking Log in opens the auth dialog in login mode', async ({ page }) => {
    const logInButton = page.getByRole('button', { name: /log in/i })
    await expect(logInButton).toBeVisible({ timeout: 10000 })
    await logInButton.click()

    // Dialog should appear with login-mode title
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()
  })

  test('clicking Sign up opens the auth dialog in signup mode', async ({ page }) => {
    const signUpButton = page.getByRole('button', { name: /sign up/i })
    await expect(signUpButton).toBeVisible({ timeout: 10000 })
    await signUpButton.click()

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('heading', { name: /create an account/i })).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // Dialog contents — login mode
  // ---------------------------------------------------------------------------

  test('login dialog shows email input', async ({ page }) => {
    await page.getByRole('button', { name: /log in/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 })

    const emailInput = page.locator('input[type="email"]')
    await expect(emailInput.first()).toBeVisible()
  })

  test('login dialog shows descriptive text about signing in', async ({ page }) => {
    await page.getByRole('button', { name: /log in/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 })

    // The dialog's sign-in tagline (auth-step-header.tsx, surface `dialog`).
    await expect(page.getByText(/sign in to vote and comment on feedback/i)).toBeVisible()
  })

  test('login dialog has a Sign up switch link for users without an account', async ({ page }) => {
    await page.getByRole('button', { name: /log in/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 })

    // "New here? Create an account" (portal-auth-form-inline.tsx). The check
    // used to look for a "Sign up" button inside an `if`, so it passed without
    // finding anything once the label changed.
    const signUpLink = page.getByRole('dialog').getByRole('button', { name: /create an account/i })
    await expect(signUpLink).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // Dialog contents — signup mode
  // ---------------------------------------------------------------------------

  test('signup dialog shows email input', async ({ page }) => {
    await page.getByRole('button', { name: /sign up/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 })

    const emailInput = page.locator('input[type="email"]')
    await expect(emailInput.first()).toBeVisible()
  })

  test('signup dialog shows descriptive text about creating an account', async ({ page }) => {
    await page.getByRole('button', { name: /sign up/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 })

    await expect(page.getByText(/sign up to vote and comment on feedback/i)).toBeVisible()
  })

  test('signup dialog shows name field when password auth is enabled', async ({
    page,
  }, testInfo) => {
    await page.getByRole('button', { name: /sign up/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await enterEmail(page, authTestEmail(testInfo))
    await expect(dialog.locator('#inline-password')).toBeVisible()
    await expect(dialog.locator('#inline-name')).toBeVisible()
  })

  test('signup dialog has a Sign in switch link for existing users', async ({ page }) => {
    await page.getByRole('button', { name: /sign up/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  })

  // ---------------------------------------------------------------------------
  // OTP email step
  // ---------------------------------------------------------------------------

  test('submitting email on the OTP step advances to the code verification step', async ({
    page,
  }, testInfo) => {
    await page.getByRole('button', { name: /log in/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    const email = authTestEmail(testInfo)
    await requestEmailCode(page, email)
    await expect(dialog.getByText(/we sent a 6-digit code to/i)).toBeVisible()
    await expect(dialog.getByText(email, { exact: true })).toBeVisible()
  })

  test('code verification step shows the OTP input', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: /log in/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await requestEmailCode(page, authTestEmail(testInfo))
    const codeInput = dialog.getByLabel('Verification code', { exact: true })
    await expect(codeInput).toBeVisible()
    await expect(codeInput).toHaveAttribute('maxlength', '6')
  })

  test('incomplete codes keep Verify disabled and the sixth digit signs in automatically', async ({
    page,
  }, testInfo) => {
    await page.getByRole('button', { name: /log in/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    const email = authTestEmail(testInfo)
    await requestEmailCode(page, email)
    const codeInput = dialog.getByLabel('Verification code', { exact: true })
    const verifyButton = dialog.getByRole('button', { name: 'Verify code', exact: true })
    await expect(verifyButton).toBeDisabled()
    await codeInput.fill('123')
    await expect(verifyButton).toBeDisabled()

    // Read the real code minted above from this run's isolated database.
    const code = getOtpCode(email)
    expect(code).toMatch(/^\d{6}$/)
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === '/api/auth/sign-in/email-otp' &&
          res.request().method() === 'POST',
        { timeout: 15000 }
      ),
      codeInput.fill(code),
    ])
    expect(response.request().postDataJSON()).toMatchObject({ email, otp: code })
    expect(response.status()).toBe(200)
    const result = await response.json()
    expect(result.user?.email).toBe(email)
    await expect(dialog).not.toBeVisible({ timeout: 10000 })
    const sessionResponse = await page.request.get('/api/auth/get-session')
    expect(sessionResponse.status()).toBe(200)
    expect((await sessionResponse.json())?.user?.email).toBe(email)
  })

  test('can return from the code step to the selected email and sign-in methods', async ({
    page,
  }, testInfo) => {
    await page.getByRole('button', { name: /log in/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    const email = authTestEmail(testInfo)
    await requestEmailCode(page, email)
    await dialog.getByRole('button', { name: 'Use a different email', exact: true }).click()
    await expect(dialog.getByLabel('Verification code', { exact: true })).toHaveCount(0)
    await expect(dialog.locator('#inline-email-locked')).toBeVisible()
    await expect(dialog.locator('#inline-email-locked')).toHaveValue(email)
  })

  test('resend cooldown button appears after sending code', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: /log in/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await requestEmailCode(page, authTestEmail(testInfo))
    const resendButton = dialog.getByRole('button', { name: /^Resend in \d+s$/ })
    await expect(resendButton).toBeVisible()
    await expect(resendButton).toBeDisabled()
  })

  // ---------------------------------------------------------------------------
  // Validation errors
  // ---------------------------------------------------------------------------

  test('an empty email keeps Continue disabled before choosing a sign-in method', async ({
    page,
  }) => {
    await page.getByRole('button', { name: /log in/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    const emailInput = dialog.locator('#inline-email')
    await expect(emailInput).toBeVisible()
    await emailInput.fill('')
    await expect(dialog.getByRole('button', { name: /^Continue\s*→$/ })).toBeDisabled()
    await expect(dialog.locator('#inline-email-locked')).toHaveCount(0)
  })

  test('credentials lock the selected email and changing it returns to email validation', async ({
    page,
  }, testInfo) => {
    await page.getByRole('button', { name: /log in/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await enterEmail(page, authTestEmail(testInfo))
    await expect(dialog.locator('#inline-password')).toBeVisible()
    await expect(dialog.locator('#inline-email-locked')).not.toBeEditable()
    await dialog.getByRole('button', { name: 'Use a different email', exact: true }).click()
    const emailInput = dialog.locator('#inline-email')
    await expect(emailInput).toBeEditable()
    await emailInput.fill('')
    await expect(dialog.getByRole('button', { name: /^Continue\s*→$/ })).toBeDisabled()
  })

  // ---------------------------------------------------------------------------
  // Closing the dialog
  // ---------------------------------------------------------------------------

  test('pressing Escape closes the auth dialog', async ({ page }) => {
    await page.getByRole('button', { name: /log in/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 })

    await page.keyboard.press('Escape')

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 })
  })

  test('clicking the X button closes the auth dialog', async ({ page }) => {
    await page.getByRole('button', { name: /log in/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).not.toBeVisible({ timeout: 5000 })
  })

  // ---------------------------------------------------------------------------
  // Mode switching
  // ---------------------------------------------------------------------------

  test('switching from login to signup changes the dialog title', async ({ page }) => {
    await page.getByRole('button', { name: /log in/i }).click()
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({
      timeout: 5000,
    })

    // Click the "Create an account" mode switch inside the dialog
    const signUpModeLink = page
      .getByRole('dialog')
      .getByRole('button', { name: /create an account/i })
    await expect(signUpModeLink).toBeVisible()
    await signUpModeLink.click()
    await expect(page.getByRole('heading', { name: /create an account/i })).toBeVisible({
      timeout: 5000,
    })
  })

  test('switching from signup to login changes the dialog title', async ({ page }) => {
    await page.getByRole('button', { name: /sign up/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(
      dialog.getByRole('heading', { name: 'Create an account', exact: true })
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: 'Welcome back', exact: true })).toBeVisible()
  })
})
