/**
 * Server-function decode guard (DEF-59, venturi-systems/landing-page#2309).
 *
 * TanStack Start decodes a `/_serverFn/<id>` payload (`JSON.parse` or
 * `request.json()`, then seroval `fromJSON`) inside the same `try` that runs
 * the function, and that `catch` answers every failure with HTTP 500 and the
 * error message (`handleServerAction` in @tanstack/start-server-core
 * 1.169.37). So a request the server cannot even read looks like a server
 * fault. Measured on feedback.venturi.systems on 2026-09-24:
 *
 *   GET  ?payload=garbage        -> 500 "JSON Parse error: Unexpected identifier ..."
 *   GET  ?payload={"t":99}       -> 500 "Seroval Error (step: 3)"
 *   POST body `{not json`        -> 500 "JSON Parse error: Expected '}'"
 *   POST empty application/json  -> 500 "Unexpected end of JSON input"
 *
 * The fork cannot reach into that `try`, but it can tell afterwards whether
 * the function ever started. Every server function runs the global function
 * middleware first, and the framework only calls the function once the
 * payload has decoded. `serverFnDispatchMarker` (registered as the first
 * global function middleware) records that start. A framework error response
 * (5xx with `x-tss-serialized: true`) for a call whose function never started
 * is therefore a request that could not be decoded, and
 * `serverFnDecodeGuardMiddleware` answers it `400 Bad Request` with no
 * detail and no stack.
 *
 * Everything else passes through untouched:
 *   - page and API routes (`handlerType === 'router'`);
 *   - successful calls;
 *   - a function's own errors: the framework returns those inside the
 *     serialized result, not through this 500 path;
 *   - a 5xx raised after the function started, such as a result that cannot
 *     be serialized, which stays a server error;
 *   - 404 (notFound), 405 (wrong method) and the CSRF 403;
 *   - thrown errors, such as an unknown function id, which reject `next()`
 *     before any response exists.
 */
import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

/** Header TanStack Start sets on every response body it serialized itself. */
const TSS_SERIALIZED_HEADER = 'x-tss-serialized'

interface DispatchProbe {
  dispatched: boolean
}

/**
 * Server-function requests in flight, each with a flag that turns true once
 * the function itself starts. Keyed by the Request object: the request
 * middleware receives the same object that `getRequest()` returns inside the
 * function (TanStack Start builds its h3 event from it unchanged).
 */
const inFlight = new WeakMap<Request, DispatchProbe>()

/** Records that the server function for `request` has started. */
export function markServerFnDispatched(request: Request | undefined): void {
  if (!request) return
  const probe = inFlight.get(request)
  if (probe) probe.dispatched = true
}

/**
 * True when `response` is the framework's catch-all error answer for a call
 * whose function never started, i.e. the payload could not be decoded.
 */
export function isUndecodedServerFnFailure(response: Response, dispatched: boolean): boolean {
  return (
    !dispatched && response.status >= 500 && response.headers.get(TSS_SERIALIZED_HEADER) === 'true'
  )
}

/**
 * The 400 answer. Plain text on purpose: the client RPC reads a JSON body
 * without `x-tss-serialized` as a successful result, but throws on a non-OK
 * text body. The body carries no decoder message and no stack.
 */
export function serverFnBadRequest(): Response {
  return new Response('Bad Request', {
    status: 400,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Minimal shape of what the framework's `next()` resolves to. */
interface NextResult {
  response: Response
}

/**
 * Core of the request middleware, decoupled from the framework so it can be
 * unit tested. Returns the framework's result unchanged unless the call
 * failed before its function started.
 */
export async function guardServerFnDecode<T extends NextResult>({
  request,
  handlerType,
  next,
}: {
  request: Request
  handlerType: 'serverFn' | 'router'
  next: () => Promise<T>
}): Promise<T | Response> {
  if (handlerType !== 'serverFn') return next()

  const probe: DispatchProbe = { dispatched: false }
  inFlight.set(request, probe)
  let result: T
  try {
    result = await next()
  } finally {
    inFlight.delete(request)
  }

  const { response } = result
  if (response instanceof Response && isUndecodedServerFnFailure(response, probe.dispatched)) {
    // Returning a new Response replaces the framework's; the pipeline
    // disposes the replaced body itself.
    return serverFnBadRequest()
  }
  return result
}

/**
 * Global request middleware: answers 400 for a server-function request whose
 * payload could not be decoded. Register it after CSRF.
 */
export const serverFnDecodeGuardMiddleware = createMiddleware().server(
  ({ request, handlerType, next }) =>
    guardServerFnDecode({ request, handlerType, next: () => Promise.resolve(next()) })
)

/**
 * Global function middleware: marks the current server-function request as
 * started. Register it first in `functionMiddleware`. It adds no context and
 * never changes the call; outside a server request (no h3 event) it does
 * nothing.
 */
export const serverFnDispatchMarker = createMiddleware({ type: 'function' }).server(({ next }) => {
  let request: Request | undefined
  try {
    request = getRequest()
  } catch {
    request = undefined
  }
  markServerFnDispatched(request)
  return next()
})
