/**
 * Pins how src/start.ts wires the server-function decode guard (DEF-59).
 *
 * The guard tells "the payload never decoded" (answer 400) from "the function
 * failed later" (keep the 500) only by whether `serverFnDispatchMarker` ran.
 * If the marker stopped firing, every post-dispatch 5xx would turn into a
 * false 400, and no end-to-end control call would notice: those calls answer
 * 200, and the guard never touches a 200. So this file pins the wiring the
 * guard depends on:
 *   - the marker is the first global function middleware. The framework runs
 *     `getStartOptions().functionMiddleware` ahead of each function's own
 *     middleware (`executeMiddleware` in @tanstack/start-client-core
 *     1.170.32), so the first entry runs as soon as the payload has decoded;
 *   - the guard is the last global request middleware, after CSRF, so a
 *     cross-site request is refused 403 before the guard answers anything;
 *   - the real marker and guard objects work as a pair: the marker marks the
 *     request that `getRequest()` returns, and the guard reads that mark.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { csrfSymbol } from '@tanstack/react-start'

const scope = vi.hoisted(() => ({ request: undefined as Request | undefined }))

// `getRequest()` reads the h3 event of the server request in flight. Unit
// tests have none, so it returns whichever request the test put in scope.
vi.mock('@tanstack/react-start/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-start/server')>()),
  getRequest: () => {
    if (!scope.request) throw new Error('No server request in scope')
    return scope.request
  },
}))

import { startInstance } from '@/start'
import { requestContextMiddleware } from '../request-context'
import { serverFnDecodeGuardMiddleware, serverFnDispatchMarker } from '../serverfn-decode-guard'

type LooseServerFn = (ctx: Record<string, unknown>) => unknown

/** The `.server(...)` function a middleware was built with. */
function serverOf(middleware: { options: object }): LooseServerFn {
  const server = (middleware.options as { server?: unknown }).server
  if (typeof server !== 'function') throw new Error('The middleware has no server function')
  return server as LooseServerFn
}

afterEach(() => {
  scope.request = undefined
})

describe('src/start.ts wiring for the decode guard', () => {
  it('runs the dispatch marker first among the global function middleware', async () => {
    const options = await startInstance.getOptions()
    expect(options.functionMiddleware?.[0]).toBe(serverFnDispatchMarker)
  })

  it('runs the decode guard last among the global request middleware, after CSRF', async () => {
    const options = await startInstance.getOptions()
    const requestMiddleware: ReadonlyArray<object> = options.requestMiddleware ?? []
    expect(requestMiddleware[0]).toBe(requestContextMiddleware)
    expect(requestMiddleware.at(-1)).toBe(serverFnDecodeGuardMiddleware)
    const csrfIndex = requestMiddleware.findIndex((middleware) => csrfSymbol in middleware)
    expect(csrfIndex, 'the CSRF middleware is registered').toBeGreaterThan(-1)
    expect(csrfIndex).toBeLessThan(requestMiddleware.indexOf(serverFnDecodeGuardMiddleware))
  })
})

describe('the real dispatch marker and decode guard work as a pair', () => {
  const FN_URL = 'http://acme.localhost:3000/_serverFn/0123abcd'

  /** The framework's catch-all answer: 500, serialized, message in the body. */
  function frameworkError(): Response {
    return new Response('{"t":25,"i":0,"s":{"message":{"t":1,"s":"boom"}},"c":"$TSR/Error"}', {
      status: 500,
      headers: { 'content-type': 'application/json', 'x-tss-serialized': 'true' },
    })
  }

  /**
   * Runs the real guard middleware around a framework stand-in that answers
   * the catch-all 500. When `markedRequest` is given, the stand-in first runs
   * the real marker middleware with that request in scope, as the framework
   * does once a payload has decoded.
   */
  async function guardAround(request: Request, markedRequest?: Request) {
    return serverOf(serverFnDecodeGuardMiddleware)({
      request,
      pathname: new URL(request.url).pathname,
      handlerType: 'serverFn',
      context: {},
      next: async () => {
        if (markedRequest) {
          scope.request = markedRequest
          try {
            await serverOf(serverFnDispatchMarker)({ next: async () => ({}) })
          } finally {
            scope.request = undefined
          }
        }
        return { response: frameworkError() }
      },
    })
  }

  it('a 500 after the marker ran for this request stays a 500', async () => {
    const request = new Request(FN_URL)
    const result = (await guardAround(request, request)) as { response: Response }
    expect(result.response.status).toBe(500)
    expect(result.response.headers.get('x-tss-serialized')).toBe('true')
  })

  it('the same 500 with no marker becomes the detail-free 400', async () => {
    const result = (await guardAround(new Request(FN_URL))) as Response
    expect(result.status).toBe(400)
    expect(await result.text()).toBe('Bad Request')
  })

  it('a mark for a different request does not count', async () => {
    const result = (await guardAround(new Request(FN_URL), new Request(FN_URL))) as Response
    expect(result.status).toBe(400)
  })

  it('the marker calls next() once and changes nothing outside a server request', async () => {
    const next = vi.fn(async () => ({ result: 'ok' }))
    await expect(serverOf(serverFnDispatchMarker)({ next })).resolves.toEqual({ result: 'ok' })
    expect(next).toHaveBeenCalledOnce()
  })
})
