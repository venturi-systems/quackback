/**
 * Console calls written through the app logger (DEF-63, DEF-66).
 *
 * A console call writes its arguments as they are: an error with its message,
 * stack, cause and enumerable properties. None of the logger's serializers or
 * sanitizers reach it. For drizzle-orm's `DrizzleQueryError` that is the SQL and
 * every bound value (`Failed query: <sql>\nparams: <values>`). Dependencies of
 * the web server print raw errors this way; for example, @better-auth/core
 * 1.6.33 `dist/db/adapter/factory.mjs:385` calls `console.error(error)` on the
 * failed query when a fallback join fails, and better-call 1.4.0
 * `dist/router.mjs:93` calls `console.error('# SERVER_ERROR: ', error)` on any
 * error an endpoint throws that is not an `APIError`.
 *
 * `routeConsoleToLogger` replaces the console's methods with ones that write
 * each call through the app logger instead (`writeLogCall`), so the err
 * serializer, the field sanitizers and the line scrub apply to it as to any
 * other log line.
 */
import type { AppLogger } from './logger'
import { errorLogMessage } from './error-serializer'

/** The app logger methods a log call can be written at. */
export type LogCallLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

/** The console methods routed, and the level each one is written at. */
const CONSOLE_LEVELS = {
  error: 'error',
  warn: 'warn',
  log: 'info',
  info: 'info',
  dir: 'info',
  debug: 'debug',
  trace: 'debug',
} as const satisfies Record<string, LogCallLevel>

type RoutedMethod = keyof typeof CONSOLE_LEVELS

/** What is written, through the original method, when a call could not be logged. */
export const CONSOLE_CALL_NOT_LOGGED = '[console] a console call could not be written to the log'

/** An error, as a console or Better Auth log call can pass one. */
function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true
  if (value === null || typeof value !== 'object') return false
  try {
    const { message, name } = value as { message?: unknown; name?: unknown }
    return typeof message === 'string' && typeof name === 'string'
  } catch {
    return false
  }
}

/**
 * Write one console-style call (a message, then any arguments) through
 * `logger` at `level`. The first error among the message and the arguments is
 * logged as `err`, so the err serializer reduces a failed query to its safe
 * shape; any other argument is logged under `args`, which `formatters.log`
 * sanitizes. The message is always a string, never `undefined`: pino would
 * otherwise write the error's own message, which for a failed query is the
 * SQL and every bound value. An error passed as the message gets the logger's
 * own safe text for it.
 */
export function writeLogCall(
  logger: AppLogger,
  level: LogCallLevel,
  message: unknown,
  args: readonly unknown[]
): void {
  const values = typeof message === 'string' ? [...args] : [message, ...args]
  const err = values.find(isErrorLike)
  const rest = values.filter((value) => value !== err && value !== undefined)
  const fields: Record<string, unknown> = {}
  if (err !== undefined) fields.err = err
  if (rest.length > 0) fields.args = rest
  const text =
    typeof message === 'string' ? message : message === err ? (errorLogMessage(err) ?? '') : ''
  logger[level](fields, text)
}

/**
 * Replace `target`'s console methods (`error`, `warn`, `log`, `info`, `dir`,
 * `debug`, `trace`) with ones that write each call through `logger`
 * (`writeLogCall`). A call made while another is being written, or one the
 * logger throws on, is not written raw: the original method writes
 * `CONSOLE_CALL_NOT_LOGGED` alone. Returns a function that puts the original
 * methods back.
 */
export function routeConsoleToLogger(logger: AppLogger, target: Console = console): () => void {
  type ConsoleMethod = (...args: unknown[]) => void
  const methods = target as unknown as Record<RoutedMethod, ConsoleMethod>
  const originals = new Map<RoutedMethod, ConsoleMethod>()
  let writing = false
  for (const method of Object.keys(CONSOLE_LEVELS) as RoutedMethod[]) {
    const original = methods[method]
    originals.set(method, original)
    methods[method] = (...callArgs: unknown[]) => {
      if (!writing) {
        writing = true
        try {
          const [message, ...args] = callArgs
          writeLogCall(logger, CONSOLE_LEVELS[method], message, args)
          return
        } catch {
          // Fall through: say that a call was lost, without its arguments.
        } finally {
          writing = false
        }
      }
      Reflect.apply(original, target, [CONSOLE_CALL_NOT_LOGGED])
    }
  }
  return () => {
    for (const [method, original] of originals) methods[method] = original
  }
}
