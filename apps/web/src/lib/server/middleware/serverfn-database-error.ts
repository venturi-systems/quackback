/**
 * Server-function database-error redaction (DEF-45, venturi-systems/landing-page#2309).
 *
 * TanStack Start answers a server function's error with the error serialized
 * into the response. Its error plugin (`$TSR/Error`, router-core 1.171.32
 * `ShallowErrorPlugin`) keeps only the `message`. Measured on
 * feedback.venturi.systems on 2026-09-24: an anonymous call to a function that
 * needs a session answered HTTP 200 with
 * `{"t":25,...,"s":{"message":{"t":1,"s":"Authentication required"}},"c":"$TSR/Error"}`.
 *
 * For a failed query that message is drizzle's
 * `Failed query: <sql>\nparams: <params>`, so the caller would get the SQL
 * text and every parameter of the query. Many functions rethrow such an error
 * as it is.
 *
 * `serverFnDatabaseErrorRedaction` is a global function middleware that wraps
 * every server function. When the function fails with a database error
 * (`isDatabaseError`), it logs `databaseErrorLogFields` on the server (the
 * statement, SQLSTATE and parameter count, never a parameter value, message or
 * Postgres detail; DEF-63) and throws a plain error with a fixed message
 * instead. Every other error, including app errors that wrap a database error
 * as their `cause`, passes through unchanged, so their classes, codes and
 * messages still reach the caller and any loader that checks them.
 */
import { createMiddleware } from '@tanstack/react-start'
import { logger } from '@/lib/server/logger'
import { databaseErrorLogFields, isDatabaseError } from '@/lib/server/errors/database-error'

const log = logger.child({ component: 'serverfn-database-error' })

/** The one logger method this middleware calls; tests pass their own. */
type ErrorLog = { error: (fields: Record<string, unknown>, message: string) => void }

/** What the caller gets instead of a failed query's own message. */
export const DATABASE_ERROR_MESSAGE = 'The request could not be completed.'

/**
 * The error a server function's caller should get for `error`: a plain error
 * with `DATABASE_ERROR_MESSAGE` for a database error, the error itself for
 * anything else.
 */
export function redactDatabaseError(error: unknown): unknown {
  return isDatabaseError(error) ? new Error(DATABASE_ERROR_MESSAGE) : error
}

/**
 * Core of the middleware, decoupled from the framework so it can be unit
 * tested: runs `next` and replaces a database error it throws.
 */
export async function withDatabaseErrorRedaction<T>(
  next: () => Promise<T>,
  errorLog: ErrorLog = log
): Promise<T> {
  try {
    return await next()
  } catch (error) {
    const redacted = redactDatabaseError(error)
    if (redacted !== error) {
      // Only the redacted shape (DEF-63): the bound parameters, the message and
      // the Postgres detail can all carry user data, so the error itself is
      // never handed to the logger.
      errorLog.error(databaseErrorLogFields(error), 'server function failed in a database query')
    }
    throw redacted
  }
}

/**
 * Global function middleware: keeps a failed query's SQL (never its bound
 * parameters) on the server. Register it right after `serverFnDispatchMarker`
 * so it wraps every other middleware and the function itself.
 */
export const serverFnDatabaseErrorRedaction = createMiddleware({ type: 'function' }).server(
  ({ next }) => withDatabaseErrorRedaction(() => Promise.resolve(next()))
)
