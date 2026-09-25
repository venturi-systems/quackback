/**
 * Postgres errors as the app meets them through drizzle-orm.
 *
 * The helpers live in `@quackback/logger/database-error` so the shared
 * logger's `err` serializer reduces a failed query to the same safe fields
 * wherever it is logged, by any package, under any key and at any depth of a
 * cause chain (DEF-63). That subpath has no imports, so this module stays safe
 * to reach from isomorphic code such as the server-function middleware.
 *
 * - `postgresErrorCode` / `isUniqueViolation` read the SQLSTATE through
 *   drizzle's `DrizzleQueryError` wrapper, whose `code` is not the Postgres
 *   one.
 * - `isDatabaseError` tells a failed query from an app error, so a server
 *   function never returns a failed query's message (`Failed query: <sql>
 *   \nparams: <params>`) to its caller (middleware/serverfn-database-error.ts).
 * - `containsDatabaseError` answers for a whole cause chain, including an app
 *   error whose own message was built from a failed query's.
 * - `databaseErrorLogFields` is what may be logged about a failed query: the
 *   SQLSTATE, the error class, the parameterized statement, the parameter
 *   count and the Postgres identifiers, never a bound value, the message or
 *   the Postgres detail.
 */
export {
  containsDatabaseError,
  databaseErrorLogFields,
  isDatabaseError,
  isUniqueViolation,
  postgresErrorCode,
} from '@quackback/logger/database-error'

/**
 * What a caller gets in place of a failed query's own message, which is its
 * SQL and every bound value.
 */
export const DATABASE_ERROR_MESSAGE = 'The request could not be completed.'
