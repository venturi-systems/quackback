import { test, expect, type APIResponse } from '@playwright/test'

/**
 * Sign-in, account and OAuth routes against the real server stack
 * (landing-page#2309).
 *
 * DEF-55: `/auth/login?error=123`, `/auth/login?callbackUrl=123`,
 * `/admin/login?error=123` and `/auth/signup?callbackUrl=123` answered HTTP
 * 500 on feedback.venturi.systems and printed the raw zod issue ("Invalid
 * input: expected string, received number") into the page. TanStack Router
 * reads `123` as a number, and those routes demanded a string.
 *
 * DEF-48: a signed-out visitor on an admin settings page was sent to sign in
 * with `callbackUrl=/admin`, so the page they asked for was lost.
 *
 * DEF-44: a page that does not exist kept the site title in the
 * server-rendered head; only a client effect renamed the tab.
 */

/** Queries a person can type, paste or follow from another site. */
const HOSTILE_PATHS = [
  '/auth/login?error=123',
  '/auth/login?callbackUrl=123',
  '/auth/login?error=123&callbackUrl=123',
  '/auth/login?error=%5B%22a%22%5D&callbackUrl=%7B%22href%22%3A%22%2Fadmin%22%7D',
  '/auth/login?error=null&callbackUrl=true',
  '/auth/login?error=%00&callbackUrl=%2Fadmin%00',
  '/admin/login?error=123',
  '/admin/login?callbackUrl=123',
  '/auth/signup?callbackUrl=123',
  '/auth/signup?error=123',
  '/auth/reset-password?token=123&error=%5B1%5D',
  '/verify-magic-link?token=%7B%7D&callbackURL=123&errorCallbackURL=%5B%5D',
  '/oauth/consent?client_id=123&state=12345',
  '/oauth/consent?client_id=%5B1%5D&scope=%7B%7D',
  '/oauth/consent',
  '/admin/settings/security/authentication?tab=bogus',
  '/admin/settings/security/authentication?tab=123',
]

/** The zod issue text the 500 page used to carry. */
const VALIDATION_ECHO = /expected (string|number|array|object), received|invalid_type/

/** A query value as the app's links write it: text that parses as JSON is quoted. */
function unquote(value: string | null): string | null {
  return value?.startsWith('"') ? (JSON.parse(value) as string) : value
}

async function expectNoServerError(res: APIResponse, path: string) {
  expect(res.status(), `${path} status`).toBeLessThan(500)
  expect(await res.text(), `${path} body`).not.toMatch(VALIDATION_ECHO)
}

test.describe('auth routes read malformed queries without failing (DEF-55)', () => {
  for (const path of HOSTILE_PATHS) {
    test(`${path} never answers 5xx or echoes a validation error`, async ({ request }) => {
      await expectNoServerError(await request.get(path), path)
    })
  }

  test('a foreign callbackUrl falls back to the portal, never another origin', async ({
    request,
  }) => {
    for (const callbackUrl of ['//evil.example', 'https://evil.example', '/\t/evil.example']) {
      const path = `/auth/login?${new URLSearchParams({ callbackUrl })}`
      const res = await request.get(path)
      await expectNoServerError(res, path)
      expect(decodeURIComponent(res.url()), `${path} final URL`).not.toContain('evil.example')
    }
  })

  test('a known error code still reaches the sign-in prompt', async ({ request }) => {
    const res = await request.get('/auth/login?error=not_team_member')
    await expectNoServerError(res, '/auth/login?error=not_team_member')
    const url = new URL(res.url())
    expect(url.searchParams.get('auth')).toBe('signin')
    expect(unquote(url.searchParams.get('error'))).toBe('not_team_member')
  })
})

test.describe('signed-out deep links into admin (DEF-48)', () => {
  test('keeps the requested settings page as the sign-in callback', async ({ request }) => {
    const requested = '/admin/settings/security/authentication?tab=sign-in'
    const res = await request.get(requested)
    await expectNoServerError(res, requested)
    const url = new URL(res.url())
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('auth')).toBe('signin')
    expect(unquote(url.searchParams.get('callbackUrl'))).toBe(requested)
  })

  test('still sends a bare /admin visit back to /admin', async ({ request }) => {
    const res = await request.get('/admin')
    await expectNoServerError(res, '/admin')
    expect(unquote(new URL(res.url()).searchParams.get('callbackUrl'))).toBe('/admin')
  })
})

test.describe('server-rendered status titles (DEF-44)', () => {
  test('a page that does not exist is titled as not found before hydration', async ({
    request,
  }) => {
    const res = await request.get('/definitely-not-a-page-e2e')
    expect(res.status()).toBe(404)
    expect(await res.text()).toContain('<title>Page not found · Venturi Feedback</title>')
  })
})
