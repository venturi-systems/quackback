// @vitest-environment node
/**
 * Tests for the `//` path redirect in the server entry.
 *
 * Production answered `GET //evil.example` with
 * `308 location: http://feedback.venturi.systems/evil.example` (2026-09-24):
 * TanStack Start's own redirect builds an absolute URL from `request.url`, which
 * starts with `http://` behind the TLS-terminating proxy. The server entry now
 * answers first with a relative Location.
 */
import { describe, it, expect } from 'vitest'
import { protocolRelativePathRedirect } from '../protocol-relative-redirect'

/** What the server sees behind the proxy: plain HTTP on the public host. */
const ORIGIN = 'http://feedback.venturi.systems'

describe('protocolRelativePathRedirect', () => {
  it.each([
    ['//evil.example', '/evil.example'],
    ['//evil.example/x?y=1', '/evil.example/x?y=1'],
    ['///evil.example', '/evil.example'],
    ['//', '/'],
    ['//admin/settings?tab=sign-in', '/admin/settings?tab=sign-in'],
    // The URL parser applies dot segments and turns backslashes into slashes
    // first, so these reach the handler as `//evil.example` too.
    ['/.//evil.example', '/evil.example'],
    ['/\\evil.example', '/evil.example'],
  ])('answers %j with a 308 to the relative path %j', (path, location) => {
    const response = protocolRelativePathRedirect(new Request(ORIGIN + path))
    expect(response).not.toBeNull()
    expect(response!.status).toBe(308)
    expect(response!.headers.get('location')).toBe(location)
  })

  it('never names a scheme, a host or a protocol-relative path in the Location', () => {
    for (const path of ['//evil.example', '////evil.example//x', '/.//evil.example?a=//b']) {
      const location = protocolRelativePathRedirect(new Request(ORIGIN + path))!.headers.get(
        'location'
      )!
      expect(location.startsWith('/')).toBe(true)
      expect(location.startsWith('//')).toBe(false)
      expect(location).not.toMatch(/^[a-z][a-z0-9+.-]*:/i)
    }
  })

  it('keeps the query exactly as it was sent', () => {
    const response = protocolRelativePathRedirect(
      new Request(`${ORIGIN}//b/ideas?board=%5B%22ideas%22%5D&q=a+b`)
    )
    expect(response!.headers.get('location')).toBe('/b/ideas?board=%5B%22ideas%22%5D&q=a+b')
  })

  it.each(['/', '/admin', '/admin//settings', '/b/ideas?next=//evil.example', '/_serverFn/'])(
    'leaves %j to the app',
    (path) => {
      expect(protocolRelativePathRedirect(new Request(ORIGIN + path))).toBeNull()
    }
  )
})
