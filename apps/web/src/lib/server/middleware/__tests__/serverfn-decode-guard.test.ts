/**
 * Tests for the server-function decode guard (DEF-59).
 *
 * `frameworkTerminal` below stands in for TanStack Start's
 * `handleServerAction` (@tanstack/start-server-core 1.169.37) at the level
 * the guard depends on:
 *   - the payload is decoded (`JSON.parse` / `request.json()`, then seroval
 *     `fromJSON`) inside the `try` that runs the function;
 *   - the global function middleware, and so `markServerFnDispatched`, runs
 *     only once the payload has decoded;
 *   - a function's own error comes back inside the serialized result, 200;
 *   - anything the `try` throws becomes 500 with `x-tss-serialized: true`
 *     and the error message in the body.
 * JSON parsing is the runtime's own. `fromJSON` is reduced to its envelope
 * check (seroval 1.6.4 rejects any value that is not a `{ t, f, m }`
 * envelope with "Seroval Error (step: 3)") plus the node types the fixtures
 * use. The end-to-end spec e2e/tests/public/serverfn-malformed-payload.spec.ts
 * runs the same cases against the real framework.
 */
import { describe, it, expect } from 'vitest'
import {
  UNKNOWN_SERVER_FN_MESSAGES,
  guardServerFnDecode,
  isServerFnRequestWithoutId,
  isUndecodedServerFnFailure,
  isUnknownServerFnError,
  markServerFnDispatched,
  serverFnBadRequest,
  serverFnIdFromPathname,
  serverFnNotFound,
} from '../serverfn-decode-guard'

const FN_URL = 'http://acme.localhost:3000/_serverFn/0123abcd'
const MAX_GET_PAYLOAD = 1_000_000

/** seroval envelope for `{ data: {} }`, as the app's RPC client sends it. */
const VALID_ENVELOPE = {
  t: { t: 10, i: 0, p: { k: ['data'], v: [{ t: 10, i: 1, p: { k: [], v: [] }, o: 0 }] }, o: 0 },
  f: 127,
  m: [],
}
/** A well-formed envelope whose root is the number 1. */
const PRIMITIVE_ROOT_ENVELOPE = { t: { t: 0, s: 1 }, f: 127, m: [] }

class SerovalStandInError extends Error {}

function decodeNode(node: unknown): unknown {
  const n = node as { t?: unknown; s?: unknown; p?: { k: string[]; v: unknown[] } }
  if (n && (n.t === 0 || n.t === 1)) return n.s
  const props = n?.p
  if (n && n.t === 10 && props) {
    const out: Record<string, unknown> = {}
    props.k.forEach((key, index) => {
      out[key] = decodeNode(props.v[index])
    })
    return out
  }
  throw new SerovalStandInError('Seroval Error (step: 3)')
}

/** Stand-in for seroval `fromJSON` (see the file header). */
function fromJSON(value: unknown): unknown {
  const envelope = value as { t?: unknown; f?: unknown; m?: unknown }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.t !== 'object' ||
    typeof envelope.f !== 'number' ||
    !Array.isArray(envelope.m)
  ) {
    throw new SerovalStandInError('Seroval Error (step: 3)')
  }
  return decodeNode(envelope.t)
}

function frameworkErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return new Response(
    JSON.stringify({ t: 25, i: 0, s: { message: { t: 1, s: message } }, c: '$TSR/Error' }),
    { status: 500, headers: { 'Content-Type': 'application/json', 'x-tss-serialized': 'true' } }
  )
}

function serialized(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'x-tss-serialized': 'true' },
  })
}

interface TerminalOptions {
  /** The server function body. Its throw is returned in the result, as the framework does. */
  handler?: (payload: Record<string, unknown>) => unknown
  /** Simulates a result that cannot be serialized after the function ran. */
  failSerialization?: boolean
}

function frameworkTerminal(request: Request, opts: TerminalOptions = {}) {
  let handlerRan = false
  const next = async () => {
    try {
      const contentType = request.headers.get('Content-Type')
      let payload: Record<string, unknown>
      if (request.method === 'GET') {
        const param = new URL(request.url).searchParams.get('payload')
        if (param && param.length > MAX_GET_PAYLOAD) throw new Error('Payload too large')
        payload = (param ? fromJSON(JSON.parse(param)) : {}) as Record<string, unknown>
      } else {
        payload = (
          contentType?.includes('application/json') ? fromJSON(await request.json()) : {}
        ) as Record<string, unknown>
      }
      // Throws a TypeError when the payload decoded to a primitive.
      payload.context = {}
      payload.method = request.method

      // action(payload): the global function middleware runs first.
      markServerFnDispatched(request)
      handlerRan = true
      let res: { result?: unknown; error?: unknown }
      try {
        res = { result: await (opts.handler ?? (() => ({ ok: true })))(payload) }
      } catch (error) {
        res = { error: error instanceof Error ? { message: error.message } : error }
      }
      if (opts.failSerialization) {
        throw new Error('Server function serialization exceeded its pending output limit')
      }
      return { response: serialized(res) }
    } catch (error) {
      return { response: frameworkErrorResponse(error) }
    }
  }
  return { next, handlerRan: () => handlerRan }
}

function getRequest(payload?: string): Request {
  const url = payload === undefined ? FN_URL : `${FN_URL}?payload=${encodeURIComponent(payload)}`
  return new Request(url, { headers: { 'x-tsr-serverFn': 'true' } })
}

function postRequest(body: string, contentType = 'application/json'): Request {
  return new Request(FN_URL, {
    method: 'POST',
    headers: { 'x-tsr-serverFn': 'true', 'Content-Type': contentType },
    body,
  })
}

async function runGuard(request: Request, opts?: TerminalOptions) {
  const terminal = frameworkTerminal(request, opts)
  const result = await guardServerFnDecode({
    request,
    handlerType: 'serverFn',
    next: terminal.next,
  })
  return { result, handlerRan: terminal.handlerRan() }
}

async function expectBadRequest(result: unknown, decoderMessage: RegExp) {
  expect(result).toBeInstanceOf(Response)
  const response = result as Response
  expect(response.status).toBe(400)
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-tss-serialized')).toBeNull()
  const body = await response.text()
  expect(body).toBe('Bad Request')
  expect(body).not.toMatch(decoderMessage)
  expect(body).not.toMatch(/\bat\s+\S+\s*\(/) // no stack frame
}

describe('guardServerFnDecode: payloads that cannot be decoded answer 400', () => {
  it('malformed JSON in a GET payload', async () => {
    const { result, handlerRan } = await runGuard(getRequest('garbage'))
    await expectBadRequest(result, /JSON|Parse|Unexpected/i)
    expect(handlerRan).toBe(false)
  })

  it('malformed JSON in a POST body', async () => {
    const { result, handlerRan } = await runGuard(postRequest('{not json'))
    await expectBadRequest(result, /JSON|Parse|Expected/i)
    expect(handlerRan).toBe(false)
  })

  it('JSON that is not a seroval envelope ({"t":99})', async () => {
    const { result, handlerRan } = await runGuard(getRequest('{"t":99}'))
    await expectBadRequest(result, /Seroval/i)
    expect(handlerRan).toBe(false)
  })

  it('a POST body that is not a seroval envelope', async () => {
    const { result, handlerRan } = await runGuard(postRequest('{"t":99}'))
    await expectBadRequest(result, /Seroval/i)
    expect(handlerRan).toBe(false)
  })

  it('an envelope whose root is a primitive the framework cannot attach context to', async () => {
    const { result, handlerRan } = await runGuard(
      getRequest(JSON.stringify(PRIMITIVE_ROOT_ENVELOPE))
    )
    await expectBadRequest(result, /context|property|TypeError/i)
    expect(handlerRan).toBe(false)
  })

  it("a GET payload over the framework's 1,000,000-character limit", async () => {
    const { result, handlerRan } = await runGuard(getRequest('a'.repeat(MAX_GET_PAYLOAD + 1)))
    await expectBadRequest(result, /too large/i)
    expect(handlerRan).toBe(false)
  })

  it('an oversized POST body (1.5 MB) that is not a seroval envelope', async () => {
    const body = JSON.stringify('a'.repeat(1_500_000))
    const { result, handlerRan } = await runGuard(postRequest(body))
    await expectBadRequest(result, /Seroval/i)
    expect(handlerRan).toBe(false)
  })

  it('an empty application/json POST body', async () => {
    const { result, handlerRan } = await runGuard(postRequest(''))
    await expectBadRequest(result, /JSON|Unexpected|end/i)
    expect(handlerRan).toBe(false)
  })
})

describe('guardServerFnDecode: everything else passes through untouched', () => {
  it('a valid GET call keeps its own response object', async () => {
    const request = getRequest(JSON.stringify(VALID_ENVELOPE))
    const terminal = frameworkTerminal(request)
    let original: Response | undefined
    const result = await guardServerFnDecode({
      request,
      handlerType: 'serverFn',
      next: async () => {
        const r = await terminal.next()
        original = r.response
        return r
      },
    })
    expect(terminal.handlerRan()).toBe(true)
    expect((result as { response: Response }).response).toBe(original)
    expect(original?.status).toBe(200)
  })

  it('a valid POST call passes its data to the function', async () => {
    let seen: unknown
    const { result, handlerRan } = await runGuard(postRequest(JSON.stringify(VALID_ENVELOPE)), {
      handler: (payload) => {
        seen = payload.data
        return 'ok'
      },
    })
    expect(handlerRan).toBe(true)
    expect(seen).toEqual({})
    expect((result as { response: Response }).response.status).toBe(200)
  })

  it("a function's own error stays in its serialized 200 result", async () => {
    const { result } = await runGuard(getRequest(JSON.stringify(VALID_ENVELOPE)), {
      handler: () => {
        throw new Error('Authentication required')
      },
    })
    const response = (result as { response: Response }).response
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Authentication required')
  })

  it('a 500 raised after the function started stays a 500', async () => {
    const { result, handlerRan } = await runGuard(getRequest(JSON.stringify(VALID_ENVELOPE)), {
      failSerialization: true,
    })
    expect(handlerRan).toBe(true)
    const response = (result as { response: Response }).response
    expect(response.status).toBe(500)
    expect(response.headers.get('x-tss-serialized')).toBe('true')
  })

  it('router requests are not inspected, even a 500', async () => {
    const original = frameworkErrorResponse(new Error('boom'))
    const request = new Request('http://acme.localhost:3000/some/page')
    const result = await guardServerFnDecode({
      request,
      handlerType: 'router',
      next: async () => ({ response: original }),
    })
    expect((result as { response: Response }).response).toBe(original)
  })

  const keptAnswers: Array<[string, () => Response]> = [
    ['405 wrong method', () => new Response('expected POST method. Got GET', { status: 405 })],
    ['404 notFound', () => new Response('{"isNotFound":true}', { status: 404 })],
    ['403 CSRF', () => new Response('Forbidden', { status: 403 })],
    ['502 without x-tss-serialized', () => new Response('upstream', { status: 502 })],
  ]
  it.each(keptAnswers)('a pre-dispatch %s answer is kept', async (_label, makeResponse) => {
    const original = makeResponse()
    const request = getRequest('garbage')
    const result = await guardServerFnDecode({
      request,
      handlerType: 'serverFn',
      next: async () => ({ response: original }),
    })
    expect((result as { response: Response }).response).toBe(original)
  })

  const propagated: Array<[string, unknown]> = [
    [
      'a function module that failed to import',
      new Error('Server function module not resolved for 0123abcd'),
    ],
    [
      'a function export that is missing',
      new Error('Server function module export not resolved for serverFn ID: 0123abcd'),
    ],
    [
      'an unknown-id message for a different id',
      new Error('Server function info not found for 9999'),
    ],
    [
      'an unknown-id message with extra text',
      new Error('Server function info not found for 0123abcd (and more)'),
    ],
    [
      'an unknown-id message for a prefix of the id',
      new Error('Server function info not found for 0123'),
    ],
    ['a non-Error value', 'Server function info not found for 0123abcd'],
    ['an abort', new DOMException('The operation was aborted.', 'AbortError')],
  ]
  it.each(propagated)('a thrown error propagates unchanged: %s', async (_label, error) => {
    const request = getRequest()
    await expect(
      guardServerFnDecode({
        request,
        handlerType: 'serverFn',
        next: async () => {
          throw error
        },
      })
    ).rejects.toBe(error)
  })
})

describe('guardServerFnDecode: an id that names no function answers 404', () => {
  async function expectNotFound(result: unknown) {
    expect(result).toBeInstanceOf(Response)
    const response = result as Response
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-tss-serialized')).toBeNull()
    const body = await response.text()
    expect(body).toBe('Not Found')
    expect(body).not.toContain('0123abcd')
  }

  it.each(UNKNOWN_SERVER_FN_MESSAGES.map((prefix) => [prefix]))(
    'the resolver error "%s<id>" for this request id',
    async (prefix) => {
      const result = await guardServerFnDecode({
        request: getRequest(),
        handlerType: 'serverFn',
        next: async () => {
          throw new Error(`${prefix}0123abcd`)
        },
      })
      await expectNotFound(result)
    }
  )

  it('a POST to an unknown id', async () => {
    const result = await guardServerFnDecode({
      request: postRequest(JSON.stringify(VALID_ENVELOPE)),
      handlerType: 'serverFn',
      next: async () => {
        throw new Error('Server function info not found for 0123abcd')
      },
    })
    await expectNotFound(result)
  })

  it("uses the framework's pathname when it is given", async () => {
    const request = new Request('http://acme.localhost:3000/_serverFn/raw-id', {
      headers: { 'x-tsr-serverFn': 'true' },
    })
    const result = await guardServerFnDecode({
      request,
      pathname: '/_serverFn/normalized-id',
      handlerType: 'serverFn',
      next: async () => {
        throw new Error('Server function info not found for normalized-id')
      },
    })
    await expectNotFound(result)
  })

  it('a matching message thrown after the function started still propagates', async () => {
    const request = getRequest(JSON.stringify(VALID_ENVELOPE))
    const error = new Error('Server function info not found for 0123abcd')
    await expect(
      guardServerFnDecode({
        request,
        handlerType: 'serverFn',
        next: async () => {
          markServerFnDispatched(request)
          throw error
        },
      })
    ).rejects.toBe(error)
  })

  it('router requests are not inspected, even with a matching message', async () => {
    const error = new Error('Server function info not found for 0123abcd')
    await expect(
      guardServerFnDecode({
        request: getRequest(),
        handlerType: 'router',
        next: async () => {
          throw error
        },
      })
    ).rejects.toBe(error)
  })
})

describe('serverFnIdFromPathname', () => {
  const table: Array<[string, string | undefined]> = [
    ['/_serverFn/0123abcd', '0123abcd'],
    ['/_serverFn/0123abcd/extra', '0123abcd'],
    ['/_serverFn/', ''],
    ['/_serverFn//0123abcd', ''],
    ['/_serverFn', undefined],
    ['/_serverFnX/0123abcd', undefined],
    ['/api/_serverFn/0123abcd', undefined],
    ['/', undefined],
  ]
  it.each(table)('%s -> %o', (pathname, expected) => {
    expect(serverFnIdFromPathname(pathname)).toBe(expected)
  })
})

describe('isUnknownServerFnError', () => {
  it('needs a non-empty id', () => {
    const error = new Error('Server function info not found for ')
    expect(isUnknownServerFnError(error, '')).toBe(false)
    expect(isUnknownServerFnError(error, undefined)).toBe(false)
  })

  it('accepts an error-like object from another realm', () => {
    expect(
      isUnknownServerFnError({ message: 'Invalid server function ID: 0123abcd' }, '0123abcd')
    ).toBe(true)
  })

  it('rejects values without a string message', () => {
    expect(isUnknownServerFnError(null, '0123abcd')).toBe(false)
    expect(isUnknownServerFnError(undefined, '0123abcd')).toBe(false)
    expect(isUnknownServerFnError({ message: 42 }, '0123abcd')).toBe(false)
  })
})

describe('isServerFnRequestWithoutId', () => {
  const table: Array<[string, boolean]> = [
    ['http://acme.localhost:3000/_serverFn/', true],
    ['http://acme.localhost:3000/_serverFn/?payload=x', true],
    ['http://acme.localhost:3000/_serverFn//0123abcd', true],
    ['http://acme.localhost:3000/_serverFn/0123abcd', false],
    ['http://acme.localhost:3000/_serverFn', false],
    ['http://acme.localhost:3000/', false],
  ]
  it.each(table)('%s -> %s', (url, expected) => {
    expect(isServerFnRequestWithoutId(new Request(url))).toBe(expected)
  })
})

describe('serverFnNotFound', () => {
  it('returns a fresh, detail-free 404 each time', async () => {
    const a = serverFnNotFound()
    const b = serverFnNotFound()
    expect(a).not.toBe(b)
    expect(a.status).toBe(404)
    expect(await a.text()).toBe('Not Found')
  })
})

describe('guardServerFnDecode: per-request bookkeeping', () => {
  it('concurrent calls are judged independently', async () => {
    const bad = getRequest('garbage')
    const good = getRequest(JSON.stringify(VALID_ENVELOPE))
    const [badResult, goodResult] = await Promise.all([runGuard(bad), runGuard(good)])
    expect((badResult.result as Response).status).toBe(400)
    expect((goodResult.result as { response: Response }).response.status).toBe(200)
  })

  it('forgets a request once its call settles', async () => {
    const request = getRequest('garbage')
    await runGuard(request)
    // A late mark for a settled request is a no-op, and so is marking an
    // unknown request or none at all.
    expect(() => markServerFnDispatched(request)).not.toThrow()
    expect(() => markServerFnDispatched(new Request(FN_URL))).not.toThrow()
    expect(() => markServerFnDispatched(undefined)).not.toThrow()
    // The same request object can be guarded again and is judged afresh.
    const again = await runGuard(request)
    expect((again.result as Response).status).toBe(400)
  })
})

describe('isUndecodedServerFnFailure', () => {
  const tss: Record<string, string> = { 'x-tss-serialized': 'true' }
  const table: Array<[number, Record<string, string>, boolean, boolean]> = [
    [500, tss, false, true],
    [503, tss, false, true],
    [500, tss, true, false],
    [500, {}, false, false],
    [200, tss, false, false],
    [404, tss, false, false],
  ]
  it.each(table)(
    'status %i headers %o dispatched %s -> %s',
    (status, headers, dispatched, expected) => {
      const response = new Response(null, { status, headers })
      expect(isUndecodedServerFnFailure(response, dispatched)).toBe(expected)
    }
  )
})

describe('serverFnBadRequest', () => {
  it('returns a fresh, detail-free 400 each time', async () => {
    const a = serverFnBadRequest()
    const b = serverFnBadRequest()
    expect(a).not.toBe(b)
    expect(a.status).toBe(400)
    expect(await a.text()).toBe('Bad Request')
  })
})
