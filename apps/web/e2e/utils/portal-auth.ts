/**
 * Reuse the setup project's authenticated demo session for portal workflows.
 *
 * Setup already signs in demo@example.com and verifies its admin role. Sending
 * another OTP for the same identity adds no coverage here and can hit the
 * shared sign-in bucket after the board-access matrix authenticates its own
 * identities. Authentication endpoint behavior has separate coverage.
 *
 * Every public project depends on setup, so a missing snapshot is an
 * infrastructure error. Never silently create another sign-in or reuse a
 * snapshot from a prior run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.auth/admin.json')

/** Pass the setup snapshot to browser.newContext({ storageState }). */
export function portalStorageState(): string {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error('Portal tests require the authenticated setup snapshot: e2e/.auth/admin.json')
  }
  return STATE_PATH
}
