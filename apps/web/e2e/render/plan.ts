/**
 * The signed-in render lane's route plan: which pages are rendered, as whom,
 * and which surfaces each page must actually show.
 *
 * The lane covers the portal surfaces quackback #131 changed. Each route names
 * those surfaces as probes. The keyboard walk fails a route whose probe is
 * missing, so a seed or routing change can never leave the lane measuring a
 * page that no longer contains what it exists to measure.
 *
 * Identities come from the end-to-end suite's own fixtures, never from real
 * credentials:
 *   - admin     demo@example.com, signed in by e2e/global-setup.ts
 *   - member    a team member (role `member`), signed in by loginViaMagicLink
 *   - anonymous no session; the signed-out variants of the same surfaces
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export type Identity = 'admin' | 'member' | 'anonymous'

/** A serialisable locator for one surface the route must render. */
export interface SurfaceProbe {
  label: string
  testId?: string
  css?: string
  role?: { role: 'button' | 'tablist' | 'link' | 'navigation'; name: string }
  text?: string
  /** `attached` for controls that are hidden until focused (the skip link). */
  state?: 'visible' | 'attached'
}

export interface RouteSpec {
  id: string
  identity: Identity
  path: string
  surfaces: SurfaceProbe[]
}

export interface RenderPlan {
  generatedAt: string
  baseURL: string
  storageStates: Record<Identity, string | null>
  /** The address each identity's session must carry; null when signed out. */
  emails: Record<Identity, string | null>
  routes: RouteSpec[]
}

const here = path.dirname(fileURLToPath(import.meta.url))

/** apps/web */
export const WEB_ROOT = path.resolve(here, '../..')

/** The seeded tenant, as the end-to-end suite addresses it. */
export const BASE_URL = 'http://acme.localhost:3000'

export const MEMBER_EMAIL = 'render-member@example.com'

export const IDENTITY_EMAILS: Record<Identity, string | null> = {
  admin: 'demo@example.com',
  member: MEMBER_EMAIL,
  anonymous: null,
}

export const STORAGE_STATES: Record<Identity, string | null> = {
  admin: path.join(WEB_ROOT, 'e2e/.auth/admin.json'),
  member: path.join(WEB_ROOT, 'e2e/.auth/render-member.json'),
  anonymous: null,
}

/** Where every report of this lane goes. CI points it at the runner's temp. */
export const OUT_DIR = path.resolve(
  process.env.RENDER_OUT_DIR || path.join(WEB_ROOT, 'test-results/render')
)
export const PLAN_PATH = path.join(OUT_DIR, 'plan.json')
export const KEYBOARD_DIR = path.join(OUT_DIR, 'keyboard')
export const CHECKER_DIR = path.join(OUT_DIR, 'checker')

export const SUITE_DIR = path.join(here, 'design-suite')

const skipLink: SurfaceProbe = {
  label: 'skip link (public-frame__skip)',
  css: 'a.public-frame__skip',
  state: 'attached',
}

/** Stands in for the seeded post's path until the database resolves it. */
export const SEEDED_POST_PATH = '{seeded-post}'

/**
 * The route matrix. The seeded post's path is resolved from the database at
 * run time (resolveRoutes), because seeded identifiers differ on every run.
 * The ids are static so the keyboard walk can declare one test per route
 * before the plan exists.
 */
export const ROUTES: readonly RouteSpec[] = [
  {
    id: 'admin-feed',
    identity: 'admin',
    path: '/',
    surfaces: [
      skipLink,
      { label: 'notification bell', role: { role: 'button', name: 'Notifications' } },
      { label: 'share-idea composer row', css: '#feedback-composer' },
    ],
  },
  {
    id: 'admin-roadmap',
    identity: 'admin',
    path: '/roadmap',
    surfaces: [skipLink, { label: 'roadmap tabs', role: { role: 'tablist', name: 'Roadmaps' } }],
  },
  {
    id: 'admin-changelog',
    identity: 'admin',
    path: '/changelog',
    surfaces: [skipLink, { label: 'changelog entry', css: 'article time[datetime]' }],
  },
  {
    id: 'admin-post',
    identity: 'admin',
    path: SEEDED_POST_PATH,
    surfaces: [
      skipLink,
      { label: 'post detail', testId: 'post-detail' },
      { label: 'comment thread', css: '[id^="comment-"]' },
    ],
  },
  {
    id: 'admin-notifications',
    identity: 'admin',
    path: '/notifications',
    surfaces: [skipLink],
  },
  {
    id: 'admin-settings-statuses',
    identity: 'admin',
    path: '/admin/settings/statuses',
    surfaces: [{ label: 'settings card description', css: 'section h2 + p' }],
  },
  {
    id: 'member-admin-only-notice',
    identity: 'member',
    path: '/admin/settings?error=not_admin',
    surfaces: [{ label: 'administrators-only notice', testId: 'admin-only-notice' }],
  },
  {
    id: 'anonymous-feed',
    identity: 'anonymous',
    path: '/',
    surfaces: [skipLink, { label: 'share-idea sign-in note', css: '.share-idea__note' }],
  },
  {
    id: 'anonymous-post',
    identity: 'anonymous',
    path: SEEDED_POST_PATH,
    surfaces: [
      skipLink,
      { label: 'post detail', testId: 'post-detail' },
      { label: 'comment sign-in prompt', text: 'Sign in to comment' },
    ],
  },
]

export function resolveRoutes(postPath: string): RouteSpec[] {
  return ROUTES.map((route) => ({
    ...route,
    path: route.path === SEEDED_POST_PATH ? postPath : route.path,
  }))
}

export function readPlan(): RenderPlan {
  if (!fs.existsSync(PLAN_PATH)) {
    throw new Error(
      `No render plan at ${PLAN_PATH}. Run the render-identities project first ` +
        '(bunx playwright test -c playwright.render.config.ts).'
    )
  }
  return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')) as RenderPlan
}
