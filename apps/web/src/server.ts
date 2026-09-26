import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { routeConsoleToLogger } from '@quackback/logger'
import { logger } from '@/lib/server/logger'
import { logStartupBanner } from '@/lib/server/startup'
import {
  isServerFnRequestWithoutId,
  serverFnNotFound,
} from '@/lib/server/middleware/serverfn-decode-guard'
import { protocolRelativePathRedirect } from '@/lib/server/middleware/protocol-relative-redirect'

// In production, every console call in this process is written through the
// app logger. Dependencies print raw errors to the console, and a failed
// query's error carries its SQL and every bound value; through the logger, the
// err serializer and sanitizers reduce it (DEF-63, DEF-66; see
// packages/logger/src/console.ts). Development keeps the plain console.
if (process.env.NODE_ENV === 'production') {
  routeConsoleToLogger(logger.child({ component: 'console' }))
}

// Cold-start optimization: eagerly warm DB + Redis connections AND preload
// the modules that bootstrap.ts dynamically imports on first SSR. The
// underlying TCP+TLS handshakes happen in parallel with Bun's module load
// + Knative's pod-readiness propagation, so by the time the first request
// reaches the handler, the import cache is warm and the connection pools
// are established. All probes are fire-and-forget; the actual query path
// retries from cold if the warmup fails.
if (process.env.SECRET_KEY) {
  Promise.all([
    import('@/lib/server/db').then(({ db, sql }) => db.execute(sql`SELECT 1`)),
    import('@/lib/server/redis').then(({ cacheGet }) => cacheGet('__warmup__')),
    import('@/lib/server/auth/index'),
    import('@/lib/server/domains/settings/settings.service'),
    import('@/lib/server/config'),
    import('@tanstack/react-start/server'),
  ]).catch(() => {
    // Pool initialization happens inside getDatabase()/getRedis(); if the
    // first probe fails the next real query will retry from cold.
  })
}

logStartupBanner()

export default createServerEntry({
  fetch(request) {
    // A path that begins with `//` is redirected to the collapsed path, as the
    // framework would, but with a relative Location: the framework's own 308
    // names `http://` behind the TLS-terminating proxy.
    const collapsed = protocolRelativePathRedirect(request)
    if (collapsed) return collapsed
    // A bare `/_serverFn/` names no server function. TanStack Start throws
    // for it before any request middleware runs, which h3 answers 500; it is
    // a client error, so answer 404 here (DEF-59).
    if (isServerFnRequestWithoutId(request)) return serverFnNotFound()
    return handler.fetch(request)
  },
})
