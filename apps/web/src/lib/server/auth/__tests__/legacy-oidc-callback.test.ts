import { describe, expect, it } from 'vitest'
import { forwardLegacyOidcCallback } from '../legacy-oidc-callback'

const registered = new Set(['sso'])
describe('legacy custom OIDC callback forwarding', () => {
  it.each(['unknown', 'google', 'sso/extra'])(
    'leaves unregistered or invalid path %s untouched',
    (id) => {
      const request = new Request(`https://qb.example/api/auth/oauth2/callback/${id}?state=s`)
      expect(forwardLegacyOidcCallback(request, registered)).toBe(request)
    }
  )

  it('preserves origin, query, method, body, cookies and headers', async () => {
    const request = new Request(
      'https://qb.example/api/auth/oauth2/callback/sso?state=s&iss=https%3A%2F%2Fidp.example',
      {
        method: 'POST',
        headers: { cookie: 'state=bound', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'code=c&state=s',
      }
    )
    const forwarded = forwardLegacyOidcCallback(request, registered)
    expect(forwarded.url).toBe(
      'https://qb.example/api/auth/callback/sso?state=s&iss=https%3A%2F%2Fidp.example'
    )
    expect(forwarded.method).toBe('POST')
    expect(forwarded.headers.get('cookie')).toBe('state=bound')
    expect(forwarded.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(await forwarded.text()).toBe('code=c&state=s')
  })
})
