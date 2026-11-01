/**
 * Route Better Auth logs and uncaught request failures through the app's
 * structured logger. Its serializers redact database parameters and tokens.
 *
 * Better Auth 1.7 catches exceptions from onAPIError.onError; use the explicit
 * onAPIError.throw option so better-call propagates non-API failures into
 * answerAuthRequest instead of printing raw errors. Typed APIError responses
 * keep their status. The production console also uses routeConsoleToLogger
 * for third-party adapter paths outside the request router.
 */
import { writeLogCall, type AppLogger } from '@quackback/logger'

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

/**
 * Better Auth 1.7 catches errors thrown by onAPIError.onError. Use its
 * explicit throw option instead, before that hook catch, so non-API errors
 * reach answerAuthRequest without better-call printing their raw values.
 * better-call still renders typed APIError responses (including 400/403).
 */
export function betterAuthApiErrorOptions(_appLog: AppLogger): { throw: true } {
  return { throw: true }
}

/**
 * Answer one request to Better Auth through `handle`. An error it throws (one
 * `betterAuthApiErrorOptions` propagated, one from a Better Auth request hook
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
