/**
 * Database helpers for E2E tests
 *
 * These utilities run CLI scripts to query the database for test-specific operations.
 * They should ONLY be used in test environments.
 */

import { execSync } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Wall-clock ceiling for every synchronous helper script this file and
 * `access-helpers.ts` shell out to.
 *
 * `execSync`/`execFileSync` block the Node event loop, so while one is running
 * Playwright's own `timeout` timer cannot fire. Without a ceiling here a script
 * that never returns is bounded only by the 90 minute GitHub job cap, and the
 * runner is killed before any reporter writes `e2e-results.json` -- so the
 * shard reports nothing at all rather than a failure. That is exactly what
 * happened to `End-to-end tests (shard 6 of 8)` on main run 34102576840: last
 * log line 08:51:30, then 87.5 minutes of silence inside a `beforeAll` retry,
 * then "The job has exceeded the maximum execution time of 1h30m0s". The same
 * shard died at the identical point on run 34101304106.
 *
 * 60s is far above the observed cost of these scripts (a single indexed query
 * against an already-open connection) and comfortably above Playwright's 30s
 * per-test timeout, so a genuine slow query still surfaces as a normal test
 * failure rather than being cut short here.
 */
export const E2E_SCRIPT_TIMEOUT_MS = 60_000

/**
 * `timeout` alone leaves a child that ignores SIGTERM running forever, which
 * is the same hang wearing a different hat. SIGKILL cannot be trapped.
 */
export const E2E_SCRIPT_KILL_SIGNAL = 'SIGKILL' as const

/**
 * Get the most recent live magic-link token for an email from the
 * verification table. Used by e2e tests to complete the magic-link
 * sign-in flow without going through real email delivery.
 */
export function getMagicLinkToken(email: string): string {
  const scriptPath = resolve(__dirname, '../scripts/get-magic-link-token.ts')

  try {
    const result = execSync(`dotenv -e ../../.env -- bun "${scriptPath}" "${email}"`, {
      encoding: 'utf-8',
      cwd: resolve(__dirname, '../..'), // apps/web directory
      timeout: E2E_SCRIPT_TIMEOUT_MS,
      killSignal: E2E_SCRIPT_KILL_SIGNAL,
    })

    return result.trim()
  } catch (error) {
    const err = error as { stderr?: string; message: string }
    throw new Error(`Failed to get magic-link token: ${err.stderr || err.message}`, {
      cause: error,
    })
  }
}

/**
 * Get the most recent live email-OTP sign-in code for an email from the
 * verification table. Used by e2e tests to complete the OTP sign-in flow
 * without going through real email delivery.
 */
export function getOtpCode(email: string): string {
  const scriptPath = resolve(__dirname, '../scripts/get-otp-code.ts')

  try {
    const result = execSync(`dotenv -e ../../.env -- bun "${scriptPath}" "${email}"`, {
      encoding: 'utf-8',
      cwd: resolve(__dirname, '../..'), // apps/web directory
      timeout: E2E_SCRIPT_TIMEOUT_MS,
      killSignal: E2E_SCRIPT_KILL_SIGNAL,
    })

    return result.trim()
  } catch (error) {
    const err = error as { stderr?: string; message: string }
    throw new Error(`Failed to get OTP code: ${err.stderr || err.message}`, {
      cause: error,
    })
  }
}

/**
 * Ensure a test user has the required role for E2E testing
 *
 * This is a test utility that ensures the demo user has the 'admin' role
 * even if the database wasn't properly seeded. Should only be used in tests.
 *
 * @param email - The email address of the user
 * @param role - The role to ensure (default: 'admin')
 */
export function ensureTestUserHasRole(email: string, role: string = 'admin'): void {
  const scriptPath = resolve(__dirname, '../scripts/ensure-role.ts')

  try {
    execSync(`dotenv -e ../../.env -- bun "${scriptPath}" "${email}" "${role}"`, {
      encoding: 'utf-8',
      cwd: resolve(__dirname, '../..'), // apps/web directory
      timeout: E2E_SCRIPT_TIMEOUT_MS,
      killSignal: E2E_SCRIPT_KILL_SIGNAL,
    })
  } catch (error) {
    const err = error as { stderr?: string; message: string }
    throw new Error(`Failed to ensure user role: ${err.stderr || err.message}`, { cause: error })
  }
}

/**
 * Pick a mention-eligible principal from the seed dataset to use as a target
 * in @-mention e2e flows. Seed names are randomised per run, so we resolve
 * the displayName + principalId at test time and excludes the demo user
 * (who is normally the one doing the mentioning).
 */
export function getMentionTarget(excludeEmail: string = 'demo@example.com'): {
  principalId: string
  displayName: string
} {
  const scriptPath = resolve(__dirname, '../scripts/get-mention-target.ts')

  try {
    const result = execSync(`dotenv -e ../../.env -- bun "${scriptPath}" "${excludeEmail}"`, {
      encoding: 'utf-8',
      cwd: resolve(__dirname, '../..'), // apps/web directory
      timeout: E2E_SCRIPT_TIMEOUT_MS,
      killSignal: E2E_SCRIPT_KILL_SIGNAL,
    })
    return JSON.parse(result.trim()) as { principalId: string; displayName: string }
  } catch (error) {
    const err = error as { stderr?: string; message: string }
    throw new Error(`Failed to get mention target: ${err.stderr || err.message}`, { cause: error })
  }
}
