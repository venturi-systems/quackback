import { test, expect } from '@playwright/test'

/**
 * A REST route answers a method it does not define with 405 and an Allow
 * header. The framework used to render the app instead, so GET on a
 * POST-only route answered 200 text/html (measured on feedback.venturi.systems:
 * 14 of the 48 documented paths).
 */
const CASES: Array<[method: 'get' | 'post' | 'put' | 'delete', path: string, allow: string]> = [
  ['get', '/api/v1/users/identify', 'POST'],
  ['get', '/api/v1/posts/post_01h455vb4pex5vsknk084sn02q/vote', 'POST'],
  ['put', '/api/v1/boards', 'GET, POST, HEAD'],
  ['delete', '/api/v1/tags', 'GET, POST, HEAD'],
]

test.describe('REST methods a route does not define', () => {
  for (const [method, path, allow] of CASES) {
    test(`${method.toUpperCase()} ${path} answers 405 with Allow: ${allow}`, async ({
      request,
    }) => {
      const res = await request[method](path)
      expect(res.status()).toBe(405)
      expect(res.headers()['allow']).toBe(allow)
      expect(res.headers()['content-type']).toContain('application/json')
      expect(await res.json()).toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } })
    })
  }

  test('a defined method still reaches its handler', async ({ request }) => {
    // No API key: the handler itself refuses, as JSON, rather than the app shell.
    const res = await request.get('/api/v1/boards')
    expect(res.status()).toBe(401)
    expect(res.headers()['content-type']).toContain('application/json')
  })
})
