/**
 * Process-level errors written through the app logger (DEF-63 class).
 *
 * An unhandled promise rejection or an uncaught exception is reported by the
 * runtime itself, not through the console, so `routeConsoleToLogger` never
 * sees it. With no listener, Bun prints the error as it is (message, stack and
 * enumerable properties) and ends the process with exit code 1. For
 * drizzle-orm's `DrizzleQueryError` that report is the SQL and every bound
 * value.
 *
 * `routeProcessErrorsToLogger` listens for both events, writes the error
 * through the app logger at `fatal` as `err`, so the err serializer, the field
 * sanitizers and the line scrub apply to it as to any other log line, and then
 * ends the process with exit code 1, as the runtime would have. It keeps the
 * runtime's decision to stop: a listener that only logged would keep serving
 * from a process whose state nobody checked. If the logger throws, the error
 * is not written raw: `PROCESS_ERROR_NOT_LOGGED` goes to stderr alone.
 */
import type { AppLogger } from './logger'

/** The message of the line written for an unhandled promise rejection. */
export const UNHANDLED_REJECTION_MESSAGE = 'unhandled promise rejection'

/** The message of the line written for an uncaught exception. */
export const UNCAUGHT_EXCEPTION_MESSAGE = 'uncaught exception'

/** What is written to stderr when a fatal error could not be logged. */
export const PROCESS_ERROR_NOT_LOGGED = '[process] a fatal error could not be written to the log'

type ProcessErrorListener = (reason: unknown) => void

/**
 * Listen on `target` for unhandled rejections and uncaught exceptions, write
 * each through `logger` at `fatal`, then end the process with exit code 1. A
 * second fatal error raised while the first is being handled is not written
 * again. Returns a function that removes the listeners.
 */
export function routeProcessErrorsToLogger(
  logger: AppLogger,
  target: NodeJS.Process = process
): () => void {
  let handling = false
  const listen =
    (message: string): ProcessErrorListener =>
    (reason) => {
      if (!handling) {
        handling = true
        try {
          logger.fatal({ err: reason }, message)
        } catch {
          try {
            target.stderr.write(`${PROCESS_ERROR_NOT_LOGGED}\n`)
          } catch {
            // Nothing is left to write to; exit regardless.
          }
        }
      }
      target.exit(1)
    }
  const onRejection = listen(UNHANDLED_REJECTION_MESSAGE)
  const onException = listen(UNCAUGHT_EXCEPTION_MESSAGE)
  target.on('unhandledRejection', onRejection)
  target.on('uncaughtException', onException)
  return () => {
    target.off('unhandledRejection', onRejection)
    target.off('uncaughtException', onException)
  }
}
