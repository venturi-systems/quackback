/**
 * A REST route answers a method it does not define with 405 and an Allow
 * header (RFC 9110 section 15.5.6). TanStack Start renders the app for a
 * method a server route has no handler for, so `GET /api/v1/users/identify`
 * (POST only) answered 200 with an empty HTML page titled "Venturi Feedback"
 * on feedback.venturi.systems.
 *
 * Route files are read as source (never executed), as the OpenAPI drift test
 * does: every /api/v1 route must carry an `ANY` handler that lists exactly the
 * methods the file defines, so a method added later cannot be refused.
 */
import { describe, it, expect } from 'vitest'
import { methodNotAllowed } from '../responses'

const sources = import.meta.glob('../../../../../routes/api/v1/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const METHOD_KEY = /^ {6}(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD):/gm
const ANY_HANDLER = /^ {6}ANY: methodNotAllowed\(\[([^\]]*)\]\),?$/gm

function routeFiles(): Array<[string, string]> {
  return Object.entries(sources).filter(
    ([file, source]) => !file.includes('/__tests__/') && /^ {4}handlers: \{$/m.test(source)
  )
}

describe('methodNotAllowed', () => {
  it('answers 405 JSON with Allow, adding HEAD wherever GET is defined', async () => {
    const res = methodNotAllowed(['GET', 'POST'])()
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('GET, POST, HEAD')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store, private')
    expect(await res.json()).toEqual({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'This endpoint accepts GET, POST, HEAD requests.',
      },
    })
  })

  it('lists only the defined methods for a route without GET', () => {
    expect(methodNotAllowed(['POST'])().headers.get('Allow')).toBe('POST')
    expect(methodNotAllowed(['OPTIONS', 'POST'])().headers.get('Allow')).toBe('OPTIONS, POST')
  })
})

describe('every /api/v1 route refuses the methods it does not define', () => {
  const files = routeFiles()

  it('reads the route files', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it.each(files.map(([file, source]) => [file.replace(/^.*routes\//, 'routes/'), source]))(
    '%s lists exactly its own methods in ANY',
    (_file, source) => {
      const defined = [...source.matchAll(METHOD_KEY)].map((m) => m[1]).sort()
      const anys = [...source.matchAll(ANY_HANDLER)]
      expect(anys).toHaveLength(1)
      const listed = anys[0][1]
        .split(',')
        .map((m) => m.trim().replace(/'/g, ''))
        .filter(Boolean)
        .sort()
      expect(listed).toEqual(defined)
    }
  )
})
