/**
 * One portal sign-in per run, shared by every public spec that needs an
 * authenticated portal session.
 *
 * WHY THIS EXISTS -- the suite was exceeding the product's own sign-in rate
 * limit, deterministically:
 *
 *   `handleSignInPreCheck` routes BOTH magic-link and email-OTP sends through
 *   `checkMagicLinkSendRateLimit` (auth/hooks.ts: provider 'magic-link' or
 *   'email'), which allows 3 sends per 15 minutes per (ip, email) and 20 per
 *   15 minutes per IP (auth/signin-rate-limit.ts, MAGIC_LINK).
 *
 *   Every e2e sign-in uses the same address (demo@example.com) from the same
 *   loopback IP: the `setup` project sends one magic link, then six describe
 *   blocks across voting.spec.ts and comments.spec.ts each sent their own OTP.
 *   That is 7 sends against a cap of 3, so at most two groups could ever
 *   authenticate -- and the old retry loop made it strictly worse, because the
 *   limiter increments on every attempt, so retrying after a 429 pushes the
 *   bucket further past the cap instead of recovering. CI run 33665960056
 *   shard 4 shows the result verbatim:
 *
 *     Rate limited on attempt 1/8, waiting 2000ms...
 *     ... through ...
 *     Rate limited on attempt 7/8, waiting 20000ms...
 *     "beforeAll" hook timeout of 90000ms exceeded.
 *
 *   The backoff ladder (2+4+8+16+20+20+20s) consumes the entire hook budget,
 *   the group is reported as "did not run", and the ~48 extra increments also
 *   exhaust the per-IP bucket for any other sign-in in the same shard.
 *
 * The fix is to stop asking for more sign-in emails than the product allows:
 * authenticate once, save the storage state, and hand every group a context
 * built from it. This changes nothing about what the tests assert, and it does
 * not touch the rate limiter -- the limit is correct, the suite was abusing it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from '@playwright/test'
import { getOtpCode } from './db-helpers'

export const PORTAL_TEST_EMAIL = 'demo@example.com'

const STATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.auth/portal.json'
)

/** In-process memo so parallel beforeAll hooks in one worker sign in once. */
let pending: Promise<string> | null = null

/**
 * Path to a storage-state file holding an authenticated portal session.
 *
 * Pass it straight to `browser.newContext({ storageState })`. Safe to call from
 * every describe block: the first call performs the single sign-in, the rest
 * await the same promise or reuse the file another worker already wrote.
 */
export function portalStorageState(browser: Browser): Promise<string> {
  if (!pending) {
    pending = signInOnce(browser).catch((error) => {
      // Let a later group retry rather than caching the failure forever.
      pending = null
      throw error
    })
  }
  return pending
}

async function signInOnce(browser: Browser): Promise<string> {
  // Another worker process in this job may already have signed in.
  if (fs.existsSync(STATE_PATH)) return STATE_PATH

  const context = await browser.newContext()
  try {
    const page = await context.newPage()

    const sendResponse = await page.request.post('/api/auth/email-otp/send-verification-otp', {
      headers: { 'Content-Type': 'application/json' },
      data: { email: PORTAL_TEST_EMAIL, type: 'sign-in' },
    })

    if (sendResponse.status() === 429) {
      // Do not retry. The limiter counts attempts, not successes, so another
      // send inside the window can only push the bucket further over the cap.
      // Report the real cause instead of burning the hook budget on backoff.
      throw new Error(
        `Sign-in OTP send was rate limited (429) for ${PORTAL_TEST_EMAIL}. ` +
          'checkMagicLinkSendRateLimit allows 3 sends per 15 min per (ip, email); ' +
          'something in this run is sending more than that for the same address.'
      )
    }

    if (!sendResponse.ok()) {
      throw new Error(
        `Failed to send sign-in OTP: ${sendResponse.status()} ${await sendResponse.text()}`
      )
    }

    // A policy block is a 302 to /?auth=signin&...&error=<code> that the request
    // context follows to a 200 page, so .ok() alone does not prove it landed.
    if (/[?&]error=/.test(sendResponse.url())) {
      throw new Error(`Sign-in OTP send was redirected to an auth error: ${sendResponse.url()}`)
    }

    const otpCode = getOtpCode(PORTAL_TEST_EMAIL)

    const verifyResponse = await page.request.post('/api/auth/sign-in/email-otp', {
      headers: { 'Content-Type': 'application/json' },
      data: { email: PORTAL_TEST_EMAIL, otp: otpCode },
    })
    if (!verifyResponse.ok()) {
      throw new Error(
        `Failed to verify sign-in OTP: ${verifyResponse.status()} ${await verifyResponse.text()}`
      )
    }

    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
    await context.storageState({ path: STATE_PATH })
    return STATE_PATH
  } finally {
    await context.close()
  }
}
