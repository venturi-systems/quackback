/**
 * Postgres errors as the app meets them through drizzle-orm.
 *
 * drizzle-orm 0.45 wraps every failed query in a `DrizzleQueryError`
 * (`pg-core/session.js` `queryWithCache`). Its message is
 * `Failed query: <sql>\nparams: <params>`, and the Postgres error itself, with
 * its SQLSTATE `code`, is only its `cause`. Two things follow:
 *
 * - A check such as `err.code === '23505'` on the caught error never matches,
 *   so code that means to absorb a unique violation must read the code
 *   through the wrapper (`postgresErrorCode`, `isUniqueViolation`).
 * - The message carries the SQL text and its parameters. TanStack Start
 *   serializes a server function's error message to the caller, so a failed
 *   query must not leave a server function as it is (`isDatabaseError`; see
 *   middleware/serverfn-database-error.ts).
 */

/** A Postgres SQLSTATE: five digits or upper-case letters, such as `23505`. */
const SQLSTATE = /^[0-9A-Z]{5}$/

/** How far down a `cause` chain to look. Real chains are one or two deep. */
const MAX_CAUSE_DEPTH = 8

/**
 * The SQLSTATE of the Postgres error behind `error`: its own `code`, or the
 * first one found down its `cause` chain (a `DrizzleQueryError` holds the
 * Postgres error as its cause). `undefined` when there is none.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== 'object') return undefined
    const { code, cause } = current as { code?: unknown; cause?: unknown }
    if (typeof code === 'string' && SQLSTATE.test(code)) return code
    current = cause
  }
  return undefined
}

/** Whether `error` is, or wraps, a Postgres unique violation (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
  return postgresErrorCode(error) === '23505'
}

/**
 * Whether `error` is itself a failed database query: drizzle's
 * `DrizzleQueryError`, or a Postgres error thrown by the driver. Read by shape,
 * not by class, so a second copy of either package cannot slip past it. An
 * app error that merely wraps one as its `cause` is not a database error: its
 * own message is the app's.
 */
export function isDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const e = error as Error & {
    query?: unknown
    params?: unknown
    code?: unknown
    severity?: unknown
  }
  // DrizzleQueryError: `query` and `params` beside its `Failed query:` message.
  if (typeof e.query === 'string' && Array.isArray(e.params)) return true
  if (e.message.startsWith('Failed query: ')) return true
  // postgres.js PostgresError: a SQLSTATE `code` with a server `severity`.
  if (e.name === 'PostgresError') return true
  return typeof e.code === 'string' && SQLSTATE.test(e.code) && typeof e.severity === 'string'
}

/**
 * Postgres error fields that name the failure without carrying a value: the
 * server's own identifiers for where it happened. `detail`, `message`,
 * `where` and `hint` are left out because Postgres puts values in them
 * (`Key (email)=(ann@acme.example) already exists`, `invalid input syntax
 * for type uuid: "<input>"`).
 */
const SAFE_POSTGRES_FIELDS = [
  ['severity', 'severity'],
  ['routine', 'routine'],
  ['schema_name', 'schema'],
  ['table_name', 'table'],
  ['column_name', 'column'],
  ['constraint_name', 'constraint'],
] as const

/**
 * What may be logged about a failed query (DEF-63). A failed query's message
 * is `Failed query: <sql>\nparams: <params>`, its `params` are the bound
 * values, and its Postgres cause can echo a value in `message` or `detail`.
 * Any of those can be a user's search text, an email address or a token, so
 * none of them is returned: only the SQLSTATE, the error class, the
 * parameterized statement, how many parameters it had, and the Postgres
 * identifiers above. Never pass the error itself, or its `cause`, to a logger.
 */
export function databaseErrorLogFields(error: unknown): Record<string, string | number> {
  const fields: Record<string, string | number> = {}
  const code = postgresErrorCode(error)
  if (code) fields.pg_code = code
  // drizzle-orm 0.45 never sets `name` on DrizzleQueryError, so fall back to
  // the class name; a bundler that renames classes only changes this label.
  if (error instanceof Error) {
    fields.error_name = error.name !== 'Error' ? error.name : error.constructor?.name || error.name
  }
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== 'object') break
    const e = current as Record<string, unknown>
    if (fields.statement === undefined && typeof e.query === 'string') fields.statement = e.query
    if (fields.param_count === undefined && Array.isArray(e.params)) {
      fields.param_count = e.params.length
    }
    for (const [from, to] of SAFE_POSTGRES_FIELDS) {
      if (fields[to] === undefined && typeof e[from] === 'string') fields[to] = e[from] as string
    }
    current = e.cause
  }
  return fields
}
