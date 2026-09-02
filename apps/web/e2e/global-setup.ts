import { test as setup, expect } from '@playwright/test'
import { getMagicLinkToken, ensureTestUserHasRole } from './utils/db-helpers'
import { enableMagicLinkSignIn } from './utils/access-helpers'

const ADMIN_EMAIL = 'demo@example.com'
const AUTH_FILE = 'e2e/.auth/admin.json'

/**
 * Global setup: Authenticate as admin via Better-auth's magic-link plugin.
 *
 * 0. Enable the magic-link sign-in method (opt-in, and the seed leaves it off)
 * 1. POST /api/auth/sign-in/magic-link to provision a verification row
 *    (in dev with no email configured the callback warns but the token
 *    still lands in the verification table)
 * 2. Read the live token directly from the DB
 * 3. GET /api/auth/magic-link/verify?token=… to consume it and set the
 *    session cookie on the page context
 * 4. Ensure the test user has admin role
 * 5. Smoke /admin and persist the auth state
 */
setup('authenticate as admin', async ({ page }) => {
  const request = page.request

  // Step 0: Open the magic-link method BEFORE the first send.
  //
  // `isSignInMethodEnabled` treats magicLink as opt-in, DEFAULT_AUTH_CONFIG
  // ships it off and `db:seed` leaves settings.auth_config NULL, so out of the
  // box `isAuthMethodAllowed` answers `magic_link_method_not_allowed`: the POST
  // below is redirected away and no verification row is ever written.
  //
  // Ordering matters beyond correctness. `checkMagicLinkSendRateLimit` allows
  // 3 sends per 15 min per (ip, email) and this project retries twice, so a
  // first attempt that could never have passed the gate would burn a third of
  // the budget that the retries need. Enabling first makes attempt 1 the one
  // that succeeds. The call is idempotent, so the retries re-assert it cheaply.
  enableMagicLinkSignIn()

  // Step 1: Trigger magic-link verification token creation
  const sendResponse = await request.post('/api/auth/sign-in/magic-link', {
    data: {
      email: ADMIN_EMAIL,
      callbackURL: '/admin',
    },
  })
  expect(sendResponse.ok()).toBeTruthy()
  // `.ok()` alone does not prove the send landed: a policy block is a 302 to
  // `/?auth=signin&…&error=<code>`, which the request context follows to a 200
  // portal page. Assert on the final URL so a blocked method reports itself
  // here instead of as a mystifying "no token in the verification table" below.
  expect(sendResponse.url(), 'magic-link send was redirected to an auth error').not.toMatch(
    /[?&]error=/
  )

  // Step 2: Pull the token directly from the verification table
  const token = getMagicLinkToken(ADMIN_EMAIL)
  expect(token.length).toBeGreaterThan(8)

  // Step 3: Verify the token — sets the session cookie via the redirect chain
  const verifyResponse = await request.get(
    `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent('/admin')}`,
    { maxRedirects: 5 }
  )
  expect(verifyResponse.ok()).toBeTruthy()

  // Step 4: Ensure test user has admin role (user now exists after verify)
  ensureTestUserHasRole(ADMIN_EMAIL, 'admin')

  // Step 5: Navigate to admin page and confirm we land there (not login).
  // No networkidle wait: with the support inbox enabled the admin shell keeps
  // SSE streams (presence/inbox) open, so the network never goes idle.
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin/, { timeout: 10000 })
  // The sidebar renders once the admin shell is hydrated — a concrete signal
  // that auth landed, without depending on the network going quiet.
  await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 10000 })

  await page.context().storageState({ path: AUTH_FILE })
})
