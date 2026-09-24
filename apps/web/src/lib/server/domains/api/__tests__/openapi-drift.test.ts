/**
 * OpenAPI drift (landing-page#2309): the published spec must describe every
 * REST route the server serves, and nothing it does not. The live spec
 * documented `/members` while the server served `/principals` (a generated
 * client would call a 404), and it omitted webhooks, suggestions, the Help
 * Center and more.
 *
 * Route files are read as source (never executed): each one's
 * createFileRoute('/api/v1/...') path and its handler methods are compared
 * with the generated document.
 */
import { describe, it, expect } from 'vitest'
import { generateOpenAPISpec } from '../openapi'
import '../schemas'

const sources = import.meta.glob('../../../../../routes/api/v1/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Served, but deliberately not part of the API-key REST contract. */
const UNDOCUMENTED = new Set([
  'GET /docs', // the interactive docs page for this spec
  'GET /openapi/json', // this spec
  'GET /mentions/suggest', // session-authenticated @-mention typeahead for the web app
  'GET /users/{principalId}/card', // session-authenticated mention hover card
  'GET /admin/usage', // control-plane endpoint authenticated by ADMIN_API_TOKEN
])

function servedOperations(): Set<string> {
  const ops = new Set<string>()
  for (const [file, source] of Object.entries(sources)) {
    if (file.includes('/__tests__/')) continue
    const route = source.match(/createFileRoute\('(\/api\/v1[^']*)'\)/)
    if (!route) continue
    let path = route[1].slice('/api/v1'.length).replace(/\$(\w+)/g, '{$1}')
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
    for (const m of source.matchAll(/^\s+(GET|POST|PUT|PATCH|DELETE):/gm)) {
      ops.add(`${m[1]} ${path || '/'}`)
    }
  }
  return ops
}

function documentedOperations(): Set<string> {
  const spec = generateOpenAPISpec() as { paths?: Record<string, Record<string, unknown>> }
  const ops = new Set<string>()
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        ops.add(`${method.toUpperCase()} ${path}`)
      }
    }
  }
  return ops
}

describe('OpenAPI drift', () => {
  const served = servedOperations()
  const documented = documentedOperations()

  it('reads the route files', () => {
    expect(served.size).toBeGreaterThan(50)
  })

  it('documents every served operation', () => {
    const missing = [...served].filter((op) => !documented.has(op) && !UNDOCUMENTED.has(op))
    expect(missing).toEqual([])
  })

  it('documents nothing the server does not serve', () => {
    const phantom = [...documented].filter((op) => !served.has(op))
    expect(phantom).toEqual([])
  })

  it('documents team members at /principals, not /members', () => {
    expect(documented.has('GET /principals')).toBe(true)
    expect([...documented].some((op) => op.includes('/members/') || op.endsWith(' /members'))).toBe(
      false
    )
  })

  it('keeps the allowlist honest (every exception is still served)', () => {
    for (const op of UNDOCUMENTED) expect(served.has(op), op).toBe(true)
  })
})
