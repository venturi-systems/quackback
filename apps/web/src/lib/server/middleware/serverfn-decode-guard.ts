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
 * TanStack 1.169.39 constructs fresh call arguments using optional property
 * access, so a decoded primitive now reaches function middleware. Capture
 * a JSON POST clone before framework handling, then inspect its envelope root
 * lazily at the first function marker. The explicit rejection flag converts its serialized
 * error to plain 400 while preserving earlier ID and method responses.
 *
 * Everything else passes through untouched:
 *   - page and API routes (`handlerType === 'router'`);
 *   - successful calls;
 *   - a function's own errors: the framework returns those inside the
 *     serialized result, not through this 500 path;
 *   - a 5xx raised after the function started, such as a result that cannot
 *     be serialized, which stays a server error;
 *   - 404 (notFound), 405 (wrong method) and the CSRF 403;
 *   - thrown errors other than the unknown-id ones below; they reject
 *     `next()` before any response exists.
 *
 * Unknown function ids. `handleServerAction` resolves the id with
 * `getServerFnById` before its `try`, so an id that names no function throws
 * out of the handler and h3 answers 500 (`{"status":500,"unhandled":true,
 * "message":"HTTPError"}` on feedback.venturi.systems, 2026-09-24). The
 * resolver's error for that case is exactly one of `UNKNOWN_SERVER_FN_MESSAGES`
 * followed by the id. The guard answers `404 Not Found` only when the thrown
 * message equals one of those strings for this request's own id and the
 * function never started; any other throw, such as a function module that
 * failed to import, still propagates as a server error. If a framework
 * upgrade rewords the messages, the guard stops matching and the old 500
 * returns. One dev-server-only caveat: when a function file fails to compile
 * before its ids were ever registered, the dev id validator swallows that
 * error and reports "Invalid server function ID", so that case answers 404
 * on the dev server.
 *
 * Ids that name an `Object.prototype` member (`constructor`, `__proto__`,
 * `toString`, `hasOwnProperty` and the rest). The production resolver looks
 * the id up in a plain object literal (`manifest[id]`), so such an id finds
 * the inherited member instead of nothing, and the resolver then throws
 * `serverFnInfo.importer is not a function`, which the exact-text match above
 * rightly does not recognise; production answered 500 for these ids on
 * 2026-09-25. The dev id validator reads a plain object the same way
 * (`serverFnsById[id]`) and lets the id through to a base64url JSON decode
 * that throws, which by the source ends in the same 500. No real id can be
 * such a name: production ids are sha256 hex digests and dev ids are
 * base64url JSON (they start with `eyJ`). So the guard answers these ids 404
 * before the framework resolves anything, with a structural check that
 * matches no error text. It runs after CSRF, so a cross-site request is still
 * refused 403 first.
 *
 * A request for the bare `/_serverFn/` names no id at all. The framework
 * throws for it before any request middleware runs, so the server entry
 * (src/server.ts) answers it with `isServerFnRequestWithoutId` and
 * `serverFnNotFound` instead.
 */
import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

/** Header TanStack Start sets on every response body it serialized itself. */
const TSS_SERIALIZED_HEADER = 'x-tss-serialized'

/**
 * Where TanStack Start serves server functions: its default `serverFns.base`
 * under the fork's router basepath `/`. vite.config.ts sets neither.
 */
export const SERVER_FN_BASE = '/_serverFn/'

/**
 * What the framework's server-function resolver throws, followed by the id,
 * when that id names no function the client may call
 * (@tanstack/start-plugin-core 1.171.46):
 *   - production build, the id is not in the manifest;
 *   - production build with a separate server-function provider environment
 *     (an RSC build, `includeClientReferencedCheck`), the function exists but
 *     is not client-callable. This fork's build has no such environment
 *     (react-start without `rsc`, so the SSR environment is the provider), so
 *     its resolver never throws this one; it stays listed in case the fork
 *     ever enables RSC;
 *   - dev server, the `validate-server-fn-id` virtual module rejects the id.
 */
export const UNKNOWN_SERVER_FN_MESSAGES = [
  'Server function info not found for ',
  'Server function not accessible from client: ',
  'Invalid server function ID: ',
] as const

/**
 * The server-function id in `pathname`, exactly as the framework slices it
 * (the first segment after `SERVER_FN_BASE`). `''` when the segment is empty;
 * `undefined` when the path is not a server-function path.
 */
export function serverFnIdFromPathname(pathname: string): string | undefined {
  if (!pathname.startsWith(SERVER_FN_BASE)) return undefined
  return pathname.slice(SERVER_FN_BASE.length).split('/')[0]
}

/**
 * True when `error` is the resolver's own "no such function" error for
 * `serverFnId`. The message must equal one of `UNKNOWN_SERVER_FN_MESSAGES`
 * plus this request's id, so no other failure can match.
 */
export function isUnknownServerFnError(error: unknown, serverFnId: string | undefined): boolean {
  if (!serverFnId) return false
  const message = (error as { message?: unknown } | null | undefined)?.message
  if (typeof message !== 'string') return false
  return UNKNOWN_SERVER_FN_MESSAGES.some((prefix) => message === prefix + serverFnId)
}

/**
 * True when `serverFnId` names a member of `Object.prototype`, such as
 * `constructor` or `__proto__`. The framework's resolver would find that
 * inherited member in its plain-object manifest and fail with a 500 instead
 * of reporting an unknown id (see the file header).
 */
export function isPrototypeMemberServerFnId(serverFnId: string | undefined): boolean {
  return !!serverFnId && serverFnId in Object.prototype
}

/**
 * True for a request to the bare server-function base (`/_serverFn/`, or an
 * empty first segment such as `/_serverFn//x`). The framework throws "Invalid
 * server action param for serverFnId" for it before any middleware runs.
 */
export function isServerFnRequestWithoutId(request: Request): boolean {
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return false
  }
  return serverFnIdFromPathname(pathname) === ''
}

/** The 404 answer for a server-function id that names no function. No detail. */
export function serverFnNotFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

interface DispatchProbe {
  dispatched: boolean
  jsonPayloadRequest?: Request
  rejectedCallRoot: boolean
}

/**
 * The RPC client wraps data/context in a record before serializing it. Seroval
 * encodes ordinary and null-prototype record roots as 10 and 11. Inspect only
 * that root metadata; nested plugin values remain the framework's concern.
 * TanStack 1.169.39 reads payload?.data instead of mutating the decoded root,
 * so primitives no longer fail decoding by themselves.
 *
 * A missing payload and FormData retain their separate transport semantics.
 * Malformed JSON/envelopes still use the framework's existing decode-error
 * path. The JSON POST clone is captured before the framework can consume the
 * original body, but read only when the first function middleware is reached.
 */
async function hasInvalidCallRoot(
  request: Request,
  jsonPayloadRequest?: Request
): Promise<boolean> {
  let envelope: unknown
  try {
    if (request.method === 'GET') {
      const payload = new URL(request.url).searchParams.get('payload')
      // Preserve the framework's own GET size limit and missing-payload path.
      if (!payload || payload.length > 1_000_000) return false
      envelope = JSON.parse(payload)
    } else if (jsonPayloadRequest) {
      envelope = await jsonPayloadRequest.json()
    } else {
      return false
    }
  } catch {
    return false
  }
  if (!envelope || typeof envelope !== 'object') return false
  const root = (envelope as { t?: unknown }).t
  if (!root || typeof root !== 'object') return false
  const kind = (root as { t?: unknown }).t
  return typeof kind === 'number' && kind !== 10 && kind !== 11
}

/**
 * Server-function requests in flight, each with a flag that turns true once
 * the function itself starts. Keyed by the Request object: the request
 * middleware receives the same object that `getRequest()` returns inside the
 * function (TanStack Start builds its h3 event from it unchanged).
 */
const inFlight = new WeakMap<Request, DispatchProbe>()

/** Reject invalid call roots at dispatch, before application middleware runs. */
export async function markServerFnDispatched(request: Request | undefined): Promise<void> {
  if (!request) return
  const probe = inFlight.get(request)
  if (!probe || probe.dispatched) return
  if (probe.rejectedCallRoot || (await hasInvalidCallRoot(request, probe.jsonPayloadRequest))) {
    probe.rejectedCallRoot = true
    throw new Error('Invalid server-function call root')
  }
  probe.dispatched = true
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
 * unit tested. Returns the framework's result unchanged unless the id names
 * an `Object.prototype` member (404 without calling `next`) or the call
 * failed before its function started. `pathname` is the framework's own
 * (normalized) request path; it defaults to the request URL's path.
 */
export async function guardServerFnDecode<T extends NextResult>({
  request,
  pathname,
  handlerType,
  next,
}: {
  request: Request
  pathname?: string
  handlerType: 'serverFn' | 'router'
  next: () => Promise<T>
}): Promise<T | Response> {
  if (handlerType !== 'serverFn') return next()

  const serverFnId = serverFnIdFromPathname(pathname ?? new URL(request.url).pathname)
  // Answered before the framework runs: its resolver would find the
  // inherited member and fail with a 500 (see the file header).
  if (isPrototypeMemberServerFnId(serverFnId)) return serverFnNotFound()

  const probe: DispatchProbe = { dispatched: false, rejectedCallRoot: false }
  if (
    request.method === 'POST' &&
    request.headers.get('content-type')?.includes('application/json')
  ) {
    try {
      // Capture the body before framework parsing, but leave it unread until
      // dispatch so an unknown ID or wrong method can respond immediately.
      probe.jsonPayloadRequest = request.clone()
    } catch {
      // A body already consumed or locked remains the framework's error.
    }
  }
  inFlight.set(request, probe)
  let result: T
  try {
    result = await next()
  } catch (error) {
    if (probe.rejectedCallRoot) return serverFnBadRequest()
    if (!probe.dispatched && isUnknownServerFnError(error, serverFnId)) {
      return serverFnNotFound()
    }
    throw error
  } finally {
    inFlight.delete(request)
    const clonedBody = probe.jsonPayloadRequest?.body
    if (clonedBody && !probe.jsonPayloadRequest?.bodyUsed) {
      // A skipped function leaves the cloned tee branch unused. Cancel it
      // without waiting: cancellation waits for the original branch too,
      // which an early 404/405 deliberately does not read.
      void clonedBody.cancel().catch(() => {})
    }
  }

  // Rejection happens only at the function marker, preserving earlier
  // unknown-id, wrong-method and CSRF responses. Handler errors stay intact.
  if (probe.rejectedCallRoot) return serverFnBadRequest()
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
 * payload could not be decoded, and 404 for one whose id names no function
 * (including an id that names an `Object.prototype` member). Register it
 * after CSRF, so a cross-site request is still refused 403 first.
 */
export const serverFnDecodeGuardMiddleware = createMiddleware().server(
  ({ request, pathname, handlerType, next }) =>
    guardServerFnDecode({
      request,
      pathname,
      handlerType,
      next: () => Promise.resolve(next()),
    })
)

/**
 * Global function middleware: marks the current server-function request as
 * started. Register it first in `functionMiddleware`, so an invalid envelope
 * is rejected before application middleware or the handler runs. Valid calls
 * add no context; outside a server request (no h3 event) it does nothing.
 */
export const serverFnDispatchMarker = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    let request: Request | undefined
    try {
      request = getRequest()
    } catch {
      request = undefined
    }
    await markServerFnDispatched(request)
    return next()
  }
)
