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
 */
import { errorLogMessage, type AppLogger } from '@quackback/logger'

/** The levels Better Auth passes to `log` ('success' arrives as 'info'). */
type BetterAuthLevel = 'debug' | 'info' | 'warn' | 'error'

/** The `logger` option this module gives `betterAuth()`. */
export interface BetterAuthLoggerOptions {
  disableColors: true
  log: (level: BetterAuthLevel, message: unknown, ...args: unknown[]) => void
}

function isErrorLike(value: unknown): value is Error {
  return (
    value instanceof Error ||
    (value !== null &&
      typeof value === 'object' &&
      typeof (value as { message?: unknown }).message === 'string' &&
      typeof (value as { name?: unknown }).name === 'string')
  )
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
  const values = typeof message === 'string' ? [...args] : [message, ...args]
  const err = values.find(isErrorLike)
  const rest = values.filter((value) => value !== err && value !== undefined)
  const fields: Record<string, unknown> = {}
  if (err !== undefined) fields.err = err
  if (rest.length > 0) fields.args = rest
  // Always a string, never undefined: pino would otherwise log the error's own
  // message, which for a failed query is the SQL and every bound value. An
  // error passed as the message gets the logger's own safe text for it.
  const text =
    typeof message === 'string'
      ? message
      : message === err
        ? (errorLogMessage(err) ?? '')
        : ''
  appLog[methodFor(level)](fields, text)
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
