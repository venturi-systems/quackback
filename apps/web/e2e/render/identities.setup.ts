/**
 * Signs in the render lane's fixture identities and writes its route plan.
 *
 * Runs after the end-to-end suite's own `setup` project (e2e/global-setup.ts),
 * which signs demo@example.com in as the administrator and saves
 * e2e/.auth/admin.json. This file adds one team member through the suite's
 * loginViaMagicLink helper, the same fixture the board-access matrix uses, and
 * picks the seeded post the post-detail routes need (find-render-post.ts). No
 * real credential is read or used anywhere: every session comes from a
 * magic-link token the test database itself issued.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as setup, expect } from '@playwright/test'
import { loginViaMagicLink, setPortalVisibility } from '../utils/access-helpers'
import { E2E_SCRIPT_KILL_SIGNAL, E2E_SCRIPT_TIMEOUT_MS } from '../utils/db-helpers'
import {
  BASE_URL,
  IDENTITY_EMAILS,
  MEMBER_EMAIL,
  OUT_DIR,
  PLAN_PATH,
  STORAGE_STATES,
  WEB_ROOT,
  resolveRoutes,
  type RenderPlan,
} from './plan'

const FIND_POST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'find-render-post.ts')

/** The seeded post the post routes render (find-render-post.ts says which). */
function findRenderPost(adminEmail: string): { path: string; ownComment: boolean } {
  const out = execFileSync('dotenv', ['-e', '../../.env', '--', 'bun', FIND_POST, adminEmail], {
    encoding: 'utf-8',
    cwd: WEB_ROOT,
    timeout: E2E_SCRIPT_TIMEOUT_MS,
    killSignal: E2E_SCRIPT_KILL_SIGNAL,
  })
  return JSON.parse(out.trim()) as { path: string; ownComment: boolean }
}

setup('sign in the render identities and write the route plan', async ({ browser }) => {
  // The signed-out surfaces (the share-idea note, the comment sign-in prompt)
  // exist only on a portal anyone can read. Set that posture explicitly rather
  // than inheriting whatever the seed left.
  setPortalVisibility('public')

  const memberState = STORAGE_STATES.member
  if (!memberState) throw new Error('The member identity needs a storage-state path')
  const context = await browser.newContext({ baseURL: BASE_URL })
  try {
    await loginViaMagicLink(context, MEMBER_EMAIL, { role: 'member' })
    const response = await context.request.get('/api/auth/get-session')
    expect(response.ok(), 'get-session for the member').toBeTruthy()
    const session = (await response.json()) as { user?: { email?: string } } | null
    expect(session?.user?.email, 'the member session belongs to the member').toBe(MEMBER_EMAIL)
    fs.mkdirSync(path.dirname(memberState), { recursive: true })
    await context.storageState({ path: memberState })
  } finally {
    await context.close()
  }

  const adminState = STORAGE_STATES.admin
  expect(adminState && fs.existsSync(adminState), 'e2e/global-setup.ts saved the admin').toBe(true)

  const post = findRenderPost(IDENTITY_EMAILS.admin ?? 'demo@example.com')
  const plan: RenderPlan = {
    generatedAt: new Date().toISOString(),
    baseURL: BASE_URL,
    storageStates: STORAGE_STATES,
    emails: IDENTITY_EMAILS,
    routes: resolveRoutes(post.path),
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`)
})
