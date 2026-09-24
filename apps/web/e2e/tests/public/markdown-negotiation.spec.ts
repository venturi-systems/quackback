import { test, expect } from '@playwright/test'

/**
 * DEF-25 (landing-page#2309): a request that prefers Markdown must get 406
 * (or the HTML page), never a server error.
 *
 * The answer comes from TanStack Start's router, before any route code runs.
 * @tanstack/start-server-core 1.169.31 answers `Accept: text/markdown` with
 * HTTP 500 {"error":"Only HTML requests are supported here"}, and production
 * returned that 500 on 2026-09-23. 1.169.37 (the version bun.lock pins now)
 * answers 406 with the same body. The feedback live check probes the same
 * request (venturi-systems/feedback scripts/check_live_feedback.py).
 *
 * This runs against the real server stack, so a dependency change that brings
 * the 500 back fails here, not in production.
 */
const PAGES = ['/', '/roadmap']

test.describe('Markdown negotiation on portal pages', () => {
  for (const path of PAGES) {
    test(`${path} answers Accept: text/markdown with 406 or a page, never 5xx`, async ({
      request,
    }) => {
      const res = await request.get(path, {
        headers: { Accept: 'text/markdown' },
        maxRedirects: 0,
      })
      expect(res.status(), `${path} status`).toBeLessThan(500)
      expect([200, 302, 303, 307, 406]).toContain(res.status())
    })

    test(`${path} still serves HTML when Markdown is preferred but HTML is acceptable`, async ({
      request,
    }) => {
      const res = await request.get(path, {
        headers: { Accept: 'text/markdown, text/html;q=0.8' },
      })
      expect(res.status(), `${path} status`).toBeLessThan(500)
      expect(res.headers()['content-type'] ?? '').toContain('text/html')
    })
  }
})
