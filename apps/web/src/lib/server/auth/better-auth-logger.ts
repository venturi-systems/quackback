/**
 * Better Auth's own log calls, routed through the app logger (DEF-66,
 * venturi-systems/landing-page#2309).
 *
 * Without a `logger.log` option, @better-auth/core 1.6.33 writes every log
 * call to the console (`dist/env/logger.mjs`: `console.error(formatted,
 * ...args)`), bypassing the app logger's err serializer and sanitizers. Several
 * Better Auth routes hand that logger a raw drizzle-orm `DrizzleQueryError`,
 * whose message is `Failed query: <sql>\nparams: <values>`:
 *
 *   - `api/routes/session.mjs:258` logs `("INTERNAL_SERVER_ERROR", error)` when
 *     get-session fails; the bound values include the session token.
 *   - `api/routes/session.mjs:397` logs the error itself as the message.
 *   - `oauth2/link-account.mjs:12` logs `("Better auth was unable to query your
 *     database.\nError: ", e)`; the bound values include the OAuth email.
 *   - `api/index.mjs:205-212` (the router's onError) logs `e.message` alone when
 *     it names a column, relation or table, so the failed query arrives as the
 *     message string.
 *
 * `betterAuthLoggerOptions` gives Better Auth a `log` function that writes each
 * call through the app logger instead. The first error among the message and
 * arguments is logged as `err`, so the err serializer reduces a failed query
 * to its statement, SQLSTATE and identifiers. Any other argument is logged
 * under `args`, which `formatters.log` sanitizes. The message goes through the
 * logger's message sanitizer, which cuts a failed query's text out of a string.
 *
 * `level` is deliberately left unset. When it is 'error', 'warn' or 'debug',
 * the router's onError also calls Better Auth's module-level console logger
 * (`api/index.mjs:201-202`: `const log = optLogLevel === ... ? logger : void 0`
 * then `log?.error(e.message)`), which no `log` option reaches. Unset, Better
 * Auth publishes 'warn' and above to `log`, and that console path stays off.
 *
 * The router has a second console path that no logger option reaches. When
 * Better Auth's onError (`api/index.mjs:193-212`) returns without a response,
 * better-call 1.4.0 (`dist/router.mjs:83-93`) turns an `APIError` into its
 * response but prints any other error raw: `console.error('# SERVER_ERROR: ',
 * error)`. Any failed query an endpoint does not catch goes that way; magic
 * link verify, for one, binds the email (`findUserByEmail`) and the new
 * session's token (`createSession`) and catches neither
 * (`plugins/magic-link/index.mjs:154-173`). `betterAuthApiErrorOptions` gives
 * Better Auth an `onAPIError.onError` that rethrows such an error: better-call
 * rethrows it in turn (`router.mjs:87-89`), and `answerAuthRequest` logs it
 * through the app logger and answers 500, as better-call would have.
 */
import { writeLogCall, type AppLogger } from '@quackback/logger'
import { isAPIError } from 'better-auth/api'

/** The levels Better Auth passes to `log` ('success' arrives as 'info'). */
type BetterAuthLevel = 'debug' | 'info' | 'warn' | 'error'

/** The `logger` option this module gives `betterAuth()`. */
export interface BetterAuthLoggerOptions {
  disableColors: true
  log: (level: BetterAuthLevel, message: unknown, ...args: unknown[]) => void
}

/** The app logger method for a Better Auth level. */
function methodFor(level: string): 'debug' | 'info' | 'warn' | 'error' {
  if (level === 'error' || level === 'warn' || level === 'debug') return level
  return 'info'
}

/**
 * Write one Better Auth log call through `appLog`. Exported for the tests,
 * which drive it with the argument shapes Better Auth's routes use.
 */
export function writeBetterAuthLog(
  appLog: AppLogger,
  level: string,
  message: unknown,
  args: readonly unknown[]
): void {
  // The first error is logged as `err` and the rest under `args`; the message
  // is always a string (see `writeLogCall` in @quackback/logger).
  writeLogCall(appLog, methodFor(level), message, args)
}

/**
 * The `logger` option for `betterAuth()`: every Better Auth log call written
 * through `appLog`, never to the console.
 */
export function betterAuthLoggerOptions(appLog: AppLogger): BetterAuthLoggerOptions {
  return {
    disableColors: true,
    log: (level, message, ...args) => writeBetterAuthLog(appLog, level, message, args),
  }
}

/** The `onAPIError` option this module gives `betterAuth()`. */
export interface BetterAuthApiErrorOptions {
  onError: (error: unknown) => void
}

/**
 * Words Better Auth's default onError looks for in an error's message
 * (`api/index.mjs:203-207`) before it logs the message alone.
 */
const SCHEMA_WORDS = ['column', 'relation', 'table', 'does not exist']

/**
 * The `onAPIError` option for `betterAuth()`. Better Auth calls it from the
 * router's onError for every error except a `FOUND` redirect
 * (`api/index.mjs:194-197`), without awaiting it, so it is synchronous.
 *
 * - An error that is not an `APIError` is rethrown. better-call rethrows it
 *   out of the handler (`router.mjs:87-89`) instead of printing it to the
 *   console, and `answerAuthRequest` logs it and answers 500.
 * - An `APIError` is logged as Better Auth's default logs it, through the app
 *   logger: its message alone when it names a schema object, and itself under
 *   its status when it is an internal server error. better-call then turns it
 *   into its response (`router.mjs:92`), as before.
 */
export function betterAuthApiErrorOptions(appLog: AppLogger): BetterAuthApiErrorOptions {
  return {
    onError(error) {
      if (!isAPIError(error)) throw error
      const message = error.message
      if (typeof message === 'string' && SCHEMA_WORDS.some((word) => message.includes(word))) {
        writeBetterAuthLog(appLog, 'error', message, [])
        return
      }
      if (error.status === 'INTERNAL_SERVER_ERROR') {
        writeBetterAuthLog(appLog, 'error', error.status, [error])
      }
    },
  }
}

/**
 * Answer one request to Better Auth through `handle`. An error it throws (one
 * `betterAuthApiErrorOptions` rethrew, one from a Better Auth request hook
 * that runs outside the router's catch, or a failure to build the auth
 * instance) is logged through `appLog`, where the err serializer reduces a
 * failed query to its safe shape, and answered with the empty 500 better-call
 * gives an error it prints. Nothing reaches the console.
 */
export async function answerAuthRequest(
  appLog: AppLogger,
  request: Request,
  handle: () => Promise<Response>
): Promise<Response> {
  try {
    return await handle()
  } catch (error) {
    // The method only: a path can carry a secret (`/reset-password/:token`).
    appLog.error({ err: error, method: request.method }, 'auth request failed')
    return new Response(null, { status: 500, statusText: 'Internal Server Error' })
  }
}
