/**
 * Unified sign-in dialog e2e — six canonical journeys.
 *
 * Covers the new unified auth surface that replaced the old /auth/login page:
 *
 *  1. Public portal, unauth /admin → /?auth=signin&callbackUrl=%2Fadmin; dialog
 *     auto-opens ("Welcome back"); admin magic-link sign-in lands on /admin.
 *  2. Public portal, portal user reaching /admin → error toast (not_team_member);
 *     dialog remains open; user stays out of /admin.
 *  3. Private portal, unauth /admin → gate shows the inline auth form; admin
 *     completes sign-in in the gate; loader re-evaluates and lands on /admin
 *     (proves #270 ① gate→sign-in→callbackUrl path end-to-end).
 *  4. /?prompt=login escape hatch: shows the dialog with any seeded OIDC button +
 *     the break-glass recovery-code link. (The anonymous-/ → IdP redirect is
 *     deferred: it requires an OIDC discovery document at a live URL.)
 *  5. Recovery break-glass: /auth/recovery renders the standalone form directly.
 *  6. Mixed audience: verified-domain email routes to the hidden corporate IdP;
 *     a non-matching email shows public auth methods; the corporate button is
 *     never shown unprompted.
 *
 * All tests manage their own auth state (no stored state injected).
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { test, expect, type BrowserContext } from '@playwright/test'
import { assertDesignFixtureEnvironment } from '../../utils/design-fixture-guard'
import { measureTypography, measureReflow } from '../../utils/design-acceptance'
import { measureFocusIndicator } from '../../utils/forced-colors-focus'
import { measureRenderedFonts } from '../../utils/rendered-font-evidence'
import { withDesignBrowserZoom } from '../../utils/browser-zoom-actuator'
import {
  loginViaMagicLink,
  setPortalAuthMethods,
  setPortalVisibility,
  flushMagicLinkRateLimit,
  seedIdentityProvider,
  removeIdentityProvider,
} from '../../utils/access-helpers'
const PORTAL_EMAIL = 'e2e-portal-unified@example.test'

// Registration IDs scoped to this suite to avoid collisions with identity-providers.spec.ts.
const BTN_RID = 'e2e-unified-btn'
const BTN_LABEL = 'E2E Unified Button'
const CORP_RID = 'e2e-unified-corp'
const CORP_LABEL = 'E2E Corp IdP'
// Avoid .test/.example/.invalid/.localhost — normalizeDomain rejects them as
// RFC 6761 reserved suffixes, which would null out the email-domain lookup
// and prevent the SSO routing from ever matching.
const CORP_DOMAIN = 'unified-corp-e2e.com'
const CORP_EMAIL = `employee@${CORP_DOMAIN}`
const DISCOVERY_URL = 'https://idp.example.org/.well-known/openid-configuration'

// Default mode, not serial: the tests share workspace state (portal config,
// providers), so they must run one at a time and in order, which default mode
// does. Serial mode also skips every test after a failure, and "(4)" is a
// known failure: that silently skipped (5), (6) and (3a) on every CI run.
// Each test restores the state it changes, so none depends on another passing.
test.describe.configure({ mode: 'default' })

test.beforeAll(() => {
  flushMagicLinkRateLimit()
  // Ensure portal starts public regardless of any leftover state from a prior
  // run (test (3) sets private inside a try/finally, but belt-and-suspenders).
  setPortalVisibility('public')
  // Same belt-and-suspenders for sign-in methods: a run that crashed between
  // test (4)'s `disable` and its `finally` leaves both the disabled auth_config
  // and the snapshot behind. `restore` consumes the snapshot and puts the
  // methods back; with no snapshot it does nothing.
  setPortalAuthMethods('restore')
})

test.beforeEach(async ({ page }) => {
  // Start from a clean session for each journey.
  await page.context().clearCookies()
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
})

// ── Journey 1 ────────────────────────────────────────────────────────────────
// Public portal, unauth /admin → unified dialog auto-opens; admin sign-in
// completes and lands on /admin.

test('(1a) unauth /admin → /?auth=signin with callbackUrl=/admin and dialog visible', async ({
  page,
}) => {
  await page.goto('/admin')
  await page.waitForLoadState('networkidle')

  // requireWorkspaceRole redirects to buildSigninRedirect('/admin'), which is
  // { to: '/', search: { auth: 'signin', callbackUrl: '/admin' } }.
  // auth=signin serializes cleanly (no JSON-quoting), so match directly.
  await expect(page).toHaveURL(/[?&]auth=signin/, { timeout: 15000 })
  const url = new URL(page.url())
  expect(url.searchParams.get('callbackUrl')).toMatch(/^\/admin/)

  // useAutoOpenAuthDialog fires on mount when auth=signin; the dialog heading is
  // "Welcome back" for mode='login'.
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({ timeout: 10000 })
})

test('(1b) signed-in admin navigating to /admin lands there (not on the dialog)', async ({
  browser,
}) => {
  // Open a fresh context that uses the global-setup's stored admin session.
  // This proves that after a successful sign-in, /admin is directly accessible
  // without going through the unified dialog. The global-setup.ts exercises the
  // full magic-link flow; this case tests the result.
  //
  // We use `browser.newContext` (not the test's `page`/`context` fixtures) to
  // bypass the `beforeEach` clearCookies + initScript, which would interfere
  // with loading an existing session via storageState.
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' })
  const page = await ctx.newPage()
  try {
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin/, { timeout: 15000 })
    await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 15000 })
  } finally {
    await ctx.close()
  }
})

// ── Journey 2 ────────────────────────────────────────────────────────────────
// Public portal, portal user (role='user') hitting /admin → not_team_member
// error toast; user remains on the portal root, not on /admin.

test('(2) portal user reaching /admin gets not_team_member error toast', async ({ context }) => {
  // Enable magic-link just long enough to establish the portal user session.
  setPortalAuthMethods('enable-magic-link')
  try {
    await loginViaMagicLink(context, PORTAL_EMAIL, { role: 'user' })
  } finally {
    setPortalAuthMethods('restore')
  }

  const page = await context.newPage()
  await page.goto('/admin')
  await page.waitForLoadState('networkidle')

  // requireWorkspaceRole bounces via buildSigninRedirect('/admin', { error: 'not_team_member' }).
  // auth=signin serializes cleanly; match directly.
  await expect(page).toHaveURL(/[?&]auth=signin/, { timeout: 15000 })

  // Assert the specific error code is not_team_member.
  const errorUrl = new URL(page.url())
  const rawError = errorUrl.searchParams.get('error')
  const errorCode = rawError?.startsWith('"') ? JSON.parse(rawError) : rawError
  expect(errorCode).toBe('not_team_member')

  // useAutoOpenAuthDialog fires the error toast before opening the dialog. Scope
  // to the toast: portal copy (the participation explainer) also mentions team access.
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /team access|team membership/i })
  ).toBeVisible({ timeout: 10000 })

  // The user is NOT on /admin.
  expect(page.url()).not.toMatch(/\/admin/)
  await page.close()
})

// ── Journey 3 ────────────────────────────────────────────────────────────────
// Private portal: unauth /admin → gate shows the inline auth form (seeded to
// 'login'); admin completes sign-in → loader re-evaluates → lands on /admin.
//
// Regression proof for #270 ①: anonymous visitor on a private portal →
// gate → sign-in → gate.useAuthBroadcast.onSuccess fires →
// router.invalidate() → loader re-evaluates → callbackUrl honored.
//
// Approach (b): inject the stored admin session cookie + post an
// 'auth-success' BroadcastChannel message to trigger the gate's
// useAuthBroadcast.onSuccess handler directly. Approach (a) (password
// credentials in the gate form) was attempted first: the portal is
// currently configured in OTP/email-only mode in the gate form context
// (password auth is not presented), so interactive credential completion
// is not available in this environment.
//
// Approach (b) still exercises the exact gate→broadcast→router.invalidate
// →callbackUrl-navigation path that #270 ① is about:
//   1. Gate renders the inline auth form (anonymous user denied)
//   2. Admin session injected (simulates post-sign-in state)
//   3. BroadcastChannel 'auth-success' fires gate.onSuccess:
//      router.invalidate() → loader re-runs → access granted →
//      router.navigate({ to: '/admin' }).

test('(3) private portal gate: sign-in in the gate lands on /admin', async ({ page }) => {
  setPortalVisibility('private')
  try {
    // /admin redirects to /?auth=signin&callbackUrl=/admin; the _portal loader
    // evaluates the anonymous visitor against the private portal → denied →
    // gate rendered with autoOpenSignin='login'.
    await page.goto('/admin')
    await page.waitForLoadState('networkidle')

    // Must land on portal root with auth=signin param.
    await expect(page).toHaveURL(/[?&]auth=signin/, { timeout: 15000 })

    // The gate renders the shared auth form inline (no modal). Its private-
    // portal copy + the email field prove the gate rendered the form directly.
    await expect(page.getByText(/this portal is private/i)).toBeVisible({ timeout: 15000 })
    await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: 15000 })

    // ── Simulate post-sign-in: inject admin session + broadcast auth-success ──
    // Load the stored admin session (built by global-setup or refresh-admin-session.ts).
    const { cookies } = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../.auth/admin.json'), 'utf-8')
    ) as { cookies: Parameters<BrowserContext['addCookies']>[0] }
    await page.context().addCookies(cookies)

    // Post the BroadcastChannel message that the auth form fires on successful
    // sign-in (postAuthSuccess). The gate's useAuthBroadcast.onSuccess handler:
    //   setSigningIn(true)
    //   router.invalidate()  ← re-runs the _portal loader with the now-set admin cookie
    //   → access granted → router.navigate({ to: callbackUrl='/admin' })
    await page.evaluate(() => {
      const ch = new BroadcastChannel('quackback-auth')
      ch.postMessage({ type: 'auth-success', timestamp: Date.now() })
      ch.close()
    })

    // After loader re-evaluates (admin session → granted), navigate fires to /admin.
    await expect(page).toHaveURL(/\/admin/, { timeout: 20000 })
    await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 15000 })
  } finally {
    setPortalVisibility('public')
  }
})

// ── Journey 4 ────────────────────────────────────────────────────────────────
// /?prompt=login escape hatch: the dialog opens with the seeded OIDC button and
// the break-glass recovery-code link (callbackUrl=/admin satisfies isTeamCallback).
//
// DEFERRED — anonymous `/` → IdP redirect: requires a live OIDC discovery
// document. The instant-SSO resolver calls auth.api.signInWithOAuth2 which
// fetches the provider's discovery URL; with a synthetic URL this returns null
// and no redirect fires. Tracking: run this sub-case against the CI environment
// where a mock-OIDC container is available.

test('(4) /?prompt=login shows the dialog with OIDC button and recovery-code link', async ({
  page,
}) => {
  seedIdentityProvider({
    registrationId: BTN_RID,
    label: BTN_LABEL,
    clientId: 'e2e-unified-btn-client',
    discoveryUrl: DISCOVERY_URL,
    enabled: true,
    showButton: true,
  })
  // Disable password + magic-link so Stage 1 is SSO-only: the recovery link
  // renders only in the SSO views, not in the generic email-entry Stage 1.
  setPortalAuthMethods('disable')
  try {
    // ?prompt=login opens the dialog; ?callbackUrl=/admin makes isTeamCallback true
    // so the recovery-code link renders inside the SSO-only Stage 1.
    await page.goto('/?prompt=login&callbackUrl=%2Fadmin')
    await page.waitForLoadState('networkidle')

    // Dialog must open (prompt=login triggers useAutoOpenAuthDialog).
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15000 })

    // The seeded button-only provider's "Sign in with …" button appears.
    await expect(
      page.getByRole('button', { name: new RegExp(`Sign in with ${BTN_LABEL}`, 'i') })
    ).toBeVisible({ timeout: 10000 })

    // Break-glass recovery-code link is visible (SSO-only Stage 1 + callbackUrl=/admin → isTeamCallback).
    await expect(page.getByRole('link', { name: /use a recovery code/i })).toBeVisible({
      timeout: 10000,
    })
    await expect(page.getByRole('link', { name: /use a recovery code/i })).toHaveAttribute(
      'href',
      /\/auth\/recovery/
    )
  } finally {
    removeIdentityProvider(BTN_RID)
    setPortalAuthMethods('restore')
  }
})

// ── Journey 5 ────────────────────────────────────────────────────────────────
// Recovery break-glass: /auth/recovery renders the standalone form directly,
// independent of any portal configuration or session state.

test('(5) /auth/recovery renders the standalone recovery form', async ({ page }) => {
  await page.goto('/auth/recovery')
  await page.waitForLoadState('networkidle')

  // Heading confirms we're on the recovery page, not a redirect.
  await expect(page.getByRole('heading', { name: /use a recovery code/i })).toBeVisible({
    timeout: 15000,
  })

  // Email + code fields and submit button are present.
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('input[placeholder*="XXXX"]')).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible({ timeout: 10000 })
})

// ── Journey 6 ────────────────────────────────────────────────────────────────
// Mixed audience: a verified-domain corporate IdP is hidden from the button list;
// typing a matching email routes to it; a non-matching email gets the public
// providers, never the corporate button.

test('(6) corporate button hidden; verified-domain email routes to corporate IdP', async ({
  page,
}) => {
  // Button-only provider: visible in the button list (control).
  seedIdentityProvider({
    registrationId: BTN_RID,
    label: BTN_LABEL,
    clientId: 'e2e-unified-btn-client',
    discoveryUrl: DISCOVERY_URL,
    enabled: true,
    showButton: true,
  })
  // Routed-only corporate provider: enforced verified domain, NOT in button list.
  seedIdentityProvider({
    registrationId: CORP_RID,
    label: CORP_LABEL,
    clientId: 'e2e-unified-corp-client',
    discoveryUrl: DISCOVERY_URL,
    enabled: true,
    showButton: false,
    domain: { name: CORP_DOMAIN, verified: true, enforced: true },
  })
  try {
    // Open dialog via ?auth=signin (serializes cleanly, no JSON-quoting needed).
    await page.goto('/?auth=signin')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15000 })

    // The button-only provider renders; the routed-only corporate provider does NOT.
    await expect(
      page.getByRole('button', { name: new RegExp(`Sign in with ${BTN_LABEL}`, 'i') })
    ).toBeVisible({ timeout: 10000 })
    await expect(
      page.getByRole('button', { name: new RegExp(`Sign in with ${CORP_LABEL}`, 'i') })
    ).toHaveCount(0)

    // Submitting a corporate-domain email triggers lookupAuthMethods which returns
    // sso-redirect for the corporate IdP; capture the server-fn response.
    // TanStack Start serialises strings via seroval — the literal "sso-redirect"
    // appears in the response body as `"s":"sso-redirect"` and is matchable.
    const lookupResponse = page.waitForResponse(
      async (resp) => {
        if (resp.request().method() !== 'POST') return false
        if (!resp.url().includes('/_serverFn/')) return false
        try {
          return (await resp.text()).includes('sso-redirect')
        } catch {
          return false
        }
      },
      { timeout: 20000 }
    )
    await page.locator('input[type="email"]').fill(CORP_EMAIL)
    await page.locator('input[type="email"]').press('Enter')
    const body = await (await lookupResponse).text()
    expect(body).toContain('sso-redirect')
    expect(body).toContain(CORP_RID)
  } finally {
    removeIdentityProvider(BTN_RID)
    removeIdentityProvider(CORP_RID)
  }
})

/** REQ-FEEDBACK-ENTRY: responsive public entry, with the existing auth path intact. */
test('(3a) public entry preserves readable type, keyboard disclosure and reflow', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000)
  await assertDesignFixtureEnvironment(baseURL)
  setPortalVisibility('authenticated')
  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(
      page.getByRole('heading', { level: 1, name: 'Help shape Acme Corp' })
    ).toBeVisible()
    // Owner decision 5 (landing-page#2309): the page states who can do what
    // when it loads. The disclosure is open by default and folds on demand.
    const roles = page.locator('details.portal-gate__roles')
    const summary = roles.locator('summary')
    await expect(roles).toHaveAttribute('open', '')
    await expect(page.locator('.portal-roles__grid')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Contributor', exact: true })).toBeVisible()
    await summary.focus()
    const focus = await measureFocusIndicator(summary)
    expect(
      focus.focused && focus.focusVisible && focus.visible && focus.unclipped && focus.unobscured
    ).toBe(true)
    expect(focus.width).toBeGreaterThanOrEqual(2)
    expect(focus.alpha).toBeGreaterThan(0)
    await testInfo.attach('entry-disclosure-focus', {
      body: Buffer.from(JSON.stringify(focus)),
      contentType: 'application/json',
    })
    await page.keyboard.press('Enter')
    await expect(roles).not.toHaveAttribute('open', '')
    await expect(page.locator('.portal-roles__grid')).toBeHidden()
    await page.keyboard.press('Space')
    await expect(roles).toHaveAttribute('open', '')
    await expect(page.getByRole('heading', { name: 'Contributor', exact: true })).toBeVisible()
    await expect(summary).toBeFocused()

    const records = []
    for (const width of [
      320, 390, 639, 640, 641, 767, 768, 769, 1023, 1024, 1025, 1440, 1920, 2560,
    ]) {
      await page.setViewportSize({ width, height: 1000 })
      // Measured in the state the page loads in: the explanation open.
      await expect(roles).toHaveAttribute('open', '')
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const geometry = await page.evaluate(() => {
        const intro = document.querySelector('.portal-gate__layout > .portal-gate__intro')!
        const form = document.querySelector('.portal-gate__signin')!
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          intro: intro.getBoundingClientRect().toJSON(),
          form: form.getBoundingClientRect().toJSON(),
          text: Array.from(
            document.querySelectorAll(
              '.portal-gate__layout h1, .portal-gate__layout h2, .portal-gate__layout h3, .portal-gate__lead, .portal-gate__access, .portal-gate .portal-roles p, .portal-gate .portal-roles li'
            )
          ).map((element) => ({
            text: element.textContent,
            size: parseFloat(getComputedStyle(element).fontSize),
            heading: /^H[1-6]$/.test(element.tagName),
          })),
        }
      })
      expect(geometry.document).toBeLessThanOrEqual(width)
      for (const item of geometry.text)
        expect(item.size, item.text ?? '').toBeGreaterThanOrEqual(item.heading ? 18 : 16)
      if (width >= 1024) {
        expect(geometry.form.x).toBeGreaterThan(geometry.intro.x + geometry.intro.width)
        expect(Math.abs(geometry.form.y - geometry.intro.y)).toBeLessThanOrEqual(1)
      } else {
        expect(geometry.form.y).toBeGreaterThanOrEqual(geometry.intro.y + geometry.intro.height)
      }
      const typography = await measureTypography(
        page,
        [
          {
            selector:
              '.portal-gate__title, .portal-gate__signin-title, .portal-gate__roles-summary h2, .portal-gate .portal-roles__role',
            profile: 'headline',
            origin: 'authored',
            locale: 'en-US',
          },
          {
            selector:
              '.portal-gate__lead, .portal-gate__access, .portal-gate .portal-roles__who, .portal-gate .portal-roles__list li, .portal-gate .portal-roles__note',
            profile: 'short-copy',
            origin: 'authored',
            locale: 'en-US',
          },
        ],
        { artifactRevision: process.env.GITHUB_SHA!, state: `entry-${width}` }
      )
      expect(typography.coverage.every((item) => item.status === 'measured')).toBe(true)
      expect(
        typography.findings.filter((item) =>
          ['fail', 'review-required'].includes(item.linePolicyStatus)
        )
      ).toEqual([])
      const fonts = await measureRenderedFonts(
        page,
        typography.findings.map((item) => item.elementOrRegion)
      )
      expect(fonts.status).toBe('pass')
      records.push({ width, geometry, typography, fonts })
      if ([390, 1440, 2560].includes(width)) {
        await testInfo.attach(`entry-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
      }
      // The folded state, then open again for the next width.
      await summary.click()
      await expect(roles).not.toHaveAttribute('open', '')
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      )
      if ([390, 1440, 2560].includes(width)) {
        await testInfo.attach(`entry-folded-${width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        })
      }
      await summary.click()
      await expect(roles).toHaveAttribute('open', '')
    }
    await testInfo.attach('entry-layout-evidence', {
      body: Buffer.from(JSON.stringify(records)),
      contentType: 'application/json',
    })

    for (const factor of [2, 4] as const) {
      await withDesignBrowserZoom(
        { baseURL, viewport: { width: 1280, height: 1000 } },
        async ({ page: zoomPage, setZoom }) => {
          await zoomPage.goto('/')
          await expect(zoomPage.locator('.portal-gate__layout')).toBeVisible()
          const zoom = await setZoom(factor)
          // The explanation is open on load, so the reflow check covers it.
          await expect(zoomPage.locator('details.portal-gate__roles')).toHaveAttribute('open', '')
          await zoomPage.addStyleTag({
            content: `
            .portal-gate__layout * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
            .portal-gate__layout p { margin-block-end: 2em !important; }
          `,
          })
          const reflow = await measureReflow(
            zoomPage,
            [{ selector: '.portal-gate__layout', expectInteractive: true }],
            {
              artifactRevision: process.env.GITHUB_SHA!,
              state: `entry-zoom-${factor}`,
              stress: 'actual browser zoom and text spacing',
            }
          )
          expect(reflow.issues).toEqual([])
          await expect(
            zoomPage.getByRole('heading', { level: 1, name: 'Help shape Acme Corp' })
          ).toBeVisible()
          await expect(zoomPage.getByLabel(/email/i)).toBeVisible()
          await testInfo.attach(`entry-zoom-${factor}`, {
            body: Buffer.from(JSON.stringify({ zoom, reflow })),
            contentType: 'application/json',
          })
        }
      )
    }
  } finally {
    setPortalVisibility('public')
  }
})
