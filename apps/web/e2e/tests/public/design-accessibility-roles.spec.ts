/**
 * A06/A08 acceptance coverage for the disposable cloud CI fixture.
 * Uses existing fixture APIs and real app routes, never synthetic response
 * bodies or production accounts. No post, comment, vote, or moderation action
 * is submitted through the UI. Actor creation/roles, segment membership and
 * idempotent access fixtures (including six published probe posts if absent)
 * are real disposable-test mutations; setupAccessFixtures has NO restore API.
 * They remain in the disposable database under that existing fixture contract.
 * Closing contexts is not claimed to undo those database/auth mutations.
 *
 * Deliberately uncovered here: global visibility/access-gate variants, a tenant
 * with no boards, deterministic loading/partial-data states, and failed media.
 * No global settings are changed to manufacture these states.
 */
import { randomUUID } from 'node:crypto'
import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test'
import {
  loginViaMagicLink,
  setupAccessFixtures,
  type AccessFixtures,
} from '../../utils/access-helpers'
import {
  assertDesignFixtureEnvironment,
  assertDesignFixtureEnvironmentSync,
} from '../../utils/design-fixture-guard'

assertDesignFixtureEnvironmentSync()

const ADMIN_STATE = 'e2e/.auth/admin.json'
const USER_EMAIL = 'olivia.chen@acme.example'
const MEMBER_EMAIL = 'noah.brooks@acme.example'
const PROBE_TITLE = 'E2E access probe post'

type Actor = 'anonymous' | 'user' | 'member' | 'admin'
type ActorPages = Record<Actor, Page>

test.describe('Design acceptance: actual fixture roles and material states', () => {
  // Existing CI uses one worker per shard. These contexts and access-board
  // fixtures belong to one serial group, matching board-access-matrix.spec.ts.
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(90_000)

  let fixtures: AccessFixtures
  let actors: ActorPages
  const contexts: BrowserContext[] = []

  async function closeContexts() {
    const results = await Promise.allSettled(contexts.splice(0).map((context) => context.close()))
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length > 0) throw new Error('Design fixture context cleanup failed')
  }

  test.beforeAll(async ({ browser, baseURL }, testInfo) => {
    await assertDesignFixtureEnvironment(baseURL)
    expect(testInfo.config.workers, 'Existing isolated CI worker contract').toBe(1)
    try {
      const createContext = async (storageState?: string) => {
        const context = await browser.newContext({
          baseURL,
          locale: 'en',
          viewport: { width: 1280, height: 800 },
          ...(storageState ? { storageState } : {}),
        })
        contexts.push(context)
        return context
      }
      const anonymous = await createContext()
      const user = await createContext()
      const member = await createContext()
      const admin = await createContext(ADMIN_STATE)

      // Explicit roles are essential: segment membership is not a team role.
      // The existing helper creates the disposable identity and applies role.
      await loginViaMagicLink(user, USER_EMAIL, { role: 'user' })
      await loginViaMagicLink(member, MEMBER_EMAIL, { role: 'member' })
      // Add the ordinary user to the fixture segment, so mixedseg is viewable
      // but its submit:team rule still denies this user. The team member needs
      // no segment membership to exercise team bypass.
      fixtures = setupAccessFixtures(USER_EMAIL)
      actors = {
        anonymous: await anonymous.newPage(),
        user: await user.newPage(),
        member: await member.newPage(),
        admin: await admin.newPage(),
      }
    } catch (error) {
      await closeContexts()
      throw error
    }
  })

  test.afterAll(async () => {
    await closeContexts()
  })

  async function openFeed(page: Page, query = '') {
    await page.goto(`/${query}`)
    await expect(page.locator('header.portal-header')).toBeVisible()
    await expect(page.locator('#feedback-title')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
  }

  test('A08: anonymous, contributor, team member and administrator retain distinct affordances', async () => {
    await openFeed(actors.anonymous)
    const anonymousHeader = actors.anonymous.locator('header.portal-header')
    await expect(anonymousHeader.getByRole('button', { name: 'Log in', exact: true })).toBeVisible()
    await expect(
      anonymousHeader.getByRole('button', { name: 'User menu', exact: true })
    ).toHaveCount(0)
    await expect(anonymousHeader.locator('a[href="/admin"]')).toHaveCount(0)

    const roles = [
      ['user', 'Contributor', false],
      ['member', 'Team member', true],
      ['admin', 'Administrator', true],
    ] as const
    for (const [actor, label, team] of roles) {
      const page = actors[actor]
      await openFeed(page)
      const header = page.locator('header.portal-header')
      await expect(header.locator('a[href="/admin"]')).toHaveCount(team ? 1 : 0)
      await header.getByRole('button', { name: 'User menu', exact: true }).click()
      try {
        const menu = page.getByRole('menu')
        await expect(menu).toBeVisible()
        await expect(menu.getByText(label, { exact: true })).toBeVisible()
      } finally {
        await page.keyboard.press('Escape')
      }
    }
  })

  test('A08: team-only post is rendered only for actual team member and administrator', async () => {
    const board = fixtures.boards.private
    const path = `/b/${board.slug}/posts/${board.postId}`
    for (const actor of ['anonymous', 'user', 'member', 'admin'] as const) {
      const page = actors[actor]
      const response = await page.goto(path)
      expect(response, `${actor}: route must return an actual document response`).not.toBeNull()
      if (actor === 'member' || actor === 'admin') {
        expect(response!.status()).toBe(200)
        const detail = page.getByTestId('post-detail')
        await expect(detail).toBeVisible()
        await expect(detail.getByRole('heading', { name: PROBE_TITLE, exact: true })).toBeVisible()
      } else {
        // The exact route maps both denied and absent posts to HTTP 404.
        // A blank page or a generic network failure must not satisfy denial.
        expect(response!.status()).toBe(404)
        await expect(page.getByTestId('venturi-site-footer')).toBeVisible()
        await expect(page.getByTestId('post-detail')).toHaveCount(0)
        await expect(page.getByRole('heading', { name: PROBE_TITLE, exact: true })).toHaveCount(0)
      }
    }
  })

  test('A06/A08: restricted composer explains the real board permission without an unusable form', async () => {
    await openFeed(actors.anonymous, `?board=${fixtures.boards.public.slug}`)
    const signIn = actors.anonymous.locator('#feedback-composer')
    await expect(signIn).toBeVisible()
    await expect(
      signIn.getByRole('button', { name: 'Sign in to share an idea', exact: true })
    ).toBeVisible()
    await expect(signIn.getByPlaceholder(/what'?s your idea/i)).toHaveCount(0)

    await openFeed(actors.user, `?board=${fixtures.boards.mixedseg.slug}`)
    const restricted = actors.user.locator('#feedback-composer.share-idea--unavailable')
    await expect(restricted).toBeVisible()
    await expect(restricted).toHaveAttribute('role', 'note')
    await expect(restricted).toContainText(
      'Your account can read this board but cannot post ideas on it.'
    )
    await expect(restricted.getByPlaceholder(/what'?s your idea/i)).toHaveCount(0)
    await expect(restricted.getByRole('button', { name: /^submit/i })).toHaveCount(0)

    for (const actor of ['member', 'admin'] as const) {
      await openFeed(actors[actor], `?board=${fixtures.boards.mixedseg.slug}`)
      const composer = actors[actor].locator('#feedback-composer')
      await expect(composer.getByPlaceholder(/what'?s your idea/i)).toBeEditable()
      await expect(composer).not.toHaveClass(/share-idea--unavailable/)
    }
  })

  test('A06: an empty real search preserves the shell and available controls', async () => {
    const page = actors.user
    const search = `design-acceptance-empty-${randomUUID()}`
    await openFeed(
      page,
      `?board=${fixtures.boards.public.slug}&search=${encodeURIComponent(search)}`
    )
    await expect(page.getByText('No posts match your filters.', { exact: true })).toBeVisible()
    await expect(page.locator('a[href*="/posts/"]:has(h3)')).toHaveCount(0)
    await expect(page.locator('#portal-main [aria-busy="true"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Search', exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Filter', exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('venturi-site-footer')).toHaveCount(1)
  })

  test('A06: a real failed refresh exposes retry and recovers without losing board selection', async ({
    baseURL,
  }, testInfo) => {
    await assertDesignFixtureEnvironment(baseURL)
    const page = actors.admin
    const board = fixtures.boards.public.slug
    await openFeed(page, `?board=${board}`)
    await expect(
      page.locator('a[href*="/posts/"]:has(h3)').filter({ hasText: PROBE_TITLE })
    ).toBeVisible()
    const fixtureOrigin = new URL(page.url()).origin
    let failedReads = 0
    const failFixtureReads = async (route: Route) => {
      const request = route.request()
      if (
        new URL(request.url()).origin === fixtureOrigin &&
        ['fetch', 'xhr'].includes(request.resourceType())
      ) {
        failedReads += 1
        await route.abort('failed')
      } else {
        await route.continue()
      }
    }
    await page.route('**/*', failFixtureReads)
    try {
      // A real failed read on this disposable page only. No RPC hash or wire
      // format is guessed, and no response body, query cache, or DOM is faked.
      // Avoid offline/online emulation: automatic reconnect refetch would race
      // the explicit Try again action this case is intended to exercise.
      await page.getByRole('button', { name: 'New', exact: true }).click()
      await expect(page).toHaveURL((url) => url.searchParams.get('sort') === 'new')
      const alert = page.getByRole('alert').filter({
        hasText: 'Feedback could not be refreshed. Your filters are still selected.',
      })
      await expect(alert).toBeVisible({ timeout: 20_000 })
      expect(failedReads, 'The app must exercise the actual failed network path').toBeGreaterThan(0)
      await expect(alert.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled()
      await expect(page).toHaveURL((url) => url.searchParams.get('board') === board)
    } finally {
      await page.unroute('**/*', failFixtureReads)
    }
    const alert = page.getByRole('alert').filter({
      hasText: 'Feedback could not be refreshed. Your filters are still selected.',
    })
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).origin === fixtureOrigin &&
          ['fetch', 'xhr'].includes(response.request().resourceType()) &&
          response.ok()
      ),
      alert.getByRole('button', { name: 'Try again', exact: true }).click(),
    ])
    // Previously rendered probe content is kept as placeholderData while
    // refetching. It cannot prove recovery until the real list settles.
    const list = page.locator('#portal-main .mt-5[aria-busy]')
    await expect(list).toHaveCount(1)
    await expect(list).toHaveAttribute('aria-busy', 'false')
    await expect(list.locator('.animate-spin')).toHaveCount(0)
    await expect(alert).toHaveCount(0)
    await expect(
      page.locator('a[href*="/posts/"]:has(h3)').filter({ hasText: PROBE_TITLE })
    ).toBeVisible()
    await expect(page).toHaveURL((url) => url.searchParams.get('board') === board)
    await testInfo.attach('retry-recovery', {
      body: Buffer.from(
        JSON.stringify({
          responseStatus: response.status(),
          resourceType: response.request().resourceType(),
          listBusy: await list.getAttribute('aria-busy'),
          selectedBoard: board,
        })
      ),
      contentType: 'application/json',
    })
  })
})
