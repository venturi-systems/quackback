/**
 * TanStack Start global configuration entry.
 *
 * Registers global request middleware that runs for every server request
 * (SSR, server routes, server functions).
 *
 * IMPORTANT: defining this file means our `requestMiddleware` list REPLACES the
 * CSRF middleware TanStack Start auto-installs when no start instance exists
 * (see start-server-core createStartHandler). So CSRF must be included here
 * explicitly, otherwise server-function mutations would silently lose
 * same-origin protection in production (the omission warning is dev-only).
 */
import { createStart, createCsrfMiddleware } from '@tanstack/react-start'
import { requestContextMiddleware } from '@/lib/server/middleware/request-context'
import {
  serverFnDecodeGuardMiddleware,
  serverFnDispatchMarker,
} from '@/lib/server/middleware/serverfn-decode-guard'
import { serverFnNulGuard } from '@/lib/server/middleware/serverfn-nul-guard'
import { serverFnDatabaseErrorRedaction } from '@/lib/server/middleware/serverfn-database-error'

/**
 * Same-origin protection for server functions, matching the framework default.
 *
 * It guards `handlerType === 'serverFn'` only — the cookie-authed RPC surface
 * (admin/portal UI). API routes are `handlerType === 'router'` and are left
 * alone, which is correct: the embeddable widget's cross-origin calls go to
 * `/api/widget/*` with `Authorization: Bearer` + `credentials: 'omit'` (no
 * cookies), so they are not CSRF-vulnerable and must not be blocked.
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
})

export const startInstance = createStart(() => {
  return {
    // Request-context/logging first so even CSRF-rejected requests get a
    // request_id and an access log; CSRF second. The decode guard runs last:
    // it answers 400, not the framework's 500, when a server-function payload
    // cannot be decoded (DEF-59).
    requestMiddleware: [requestContextMiddleware, csrfMiddleware, serverFnDecodeGuardMiddleware],
    // The dispatch marker must stay first: it tells the decode guard that the
    // function started, i.e. that the payload decoded. It adds no context.
    // The database-error redaction wraps everything after it, so a failed
    // query's SQL and parameters stay on the server. The NUL guard then
    // refuses any input holding a NUL, which Postgres cannot store, before
    // the function's own validator runs (DEF-45).
    functionMiddleware: [serverFnDispatchMarker, serverFnDatabaseErrorRedaction, serverFnNulGuard],
  }
})
