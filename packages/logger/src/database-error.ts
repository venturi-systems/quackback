/**
 * Postgres errors as the app meets them through drizzle-orm (DEF-45, DEF-63).
 *
 * drizzle-orm 0.45 wraps every failed query in a `DrizzleQueryError`
 * (`pg-core/session.js` `queryWithCache`). Its message is
 * `Failed query: <sql>\nparams: <params>`, it holds the bound values as its
 * enumerable `params`, and the Postgres error itself, with its SQLSTATE
 * `code`, is only its `cause`. Three things follow:
 *
 * - A check such as `err.code === '23505'` on the caught error never matches,
 *   so code that means to absorb a unique violation must read the code
 *   through the wrapper (`postgresErrorCode`, `isUniqueViolation`).
 * - TanStack Start serializes a server function's error message to the
 *   caller, so a failed query must not leave a server function as it is
 *   (`isDatabaseError`; see the web app's middleware/serverfn-database-error.ts).
 * - A logger that prints the error, its message, its enumerable properties or
 *   its cause writes every bound value to the log: a user's search text, an
 *   email address, a token. The shared logger reduces any database error it
 *   is handed to `databaseErrorLogFields` (see ./error-serializer.ts).
 *
 * This module has no imports, so browser-reachable code may use it through
 * `@quackback/logger/database-error` without pulling pino or
 * node:async_hooks into the client bundle.
 */

/** A Postgres SQLSTATE: five digits or upper-case letters, such as `23505`. */
const SQLSTATE = /^[0-9A-Z]{5}$/

/** How far down a `cause` chain to look. Real chains are one or two deep. */
const MAX_CAUSE_DEPTH = 8

/** How deep `failedQueryReach` follows causes, errors and properties. */
const MAX_GRAPH_DEPTH = 32

/**
 * How many values `failedQueryReach` inspects. A graph larger than this is
 * not walked to the end and is taken to hold a failed query, so a log line is
 * never cheaper to make than it is safe.
 */
const MAX_GRAPH_VALUES = 10_000

/** How every drizzle-orm failed-query message starts. */
export const FAILED_QUERY_MARKER = 'Failed query: '

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
 * own message is the app's (`containsDatabaseError` answers for the chain).
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
  if (typeof e.message === 'string' && e.message.startsWith(FAILED_QUERY_MARKER)) return true
  // postgres.js PostgresError: a SQLSTATE `code` with a server `severity`.
  if (e.name === 'PostgresError') return true
  return typeof e.code === 'string' && SQLSTATE.test(e.code) && typeof e.severity === 'string'
}

/** An object literal or `Object.create(null)`, as opposed to a class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Read one property without letting a throwing getter escape. */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** Whether `value` has a string `message`, the test pino uses for an error. */
function hasMessage(value: object): boolean {
  return typeof readProperty(value, 'message') === 'string'
}

/**
 * The property names a log line can write for `value`. An error is written by
 * pino's serializer (or ./error-serializer.ts), which reads its enumerable
 * properties, own and inherited; anything else is written by `JSON.stringify`,
 * which reads its own enumerable properties only.
 */
function writtenKeys(value: object, errorLike: boolean): string[] {
  if (!errorLike) return Object.keys(value)
  const keys: string[] = []
  for (const key in value) keys.push(key)
  return keys
}

/** How `failedQueryReach` reads one object. */
interface NodeShape {
  isArray: boolean
  isError: boolean
  errorLike: boolean
  database: boolean
  keys: string[]
}

/**
 * How `failedQueryReach` reads `value`, or `undefined` when a proxy or other
 * exotic object throws while it is inspected (such a value cannot be cleared).
 */
function nodeShape(value: object): NodeShape | undefined {
  try {
    if (Array.isArray(value)) {
      return { isArray: true, isError: false, errorLike: false, database: false, keys: [] }
    }
    const isError = value instanceof Error
    const errorLike = isError || hasMessage(value)
    return {
      isArray: false,
      isError,
      errorLike,
      database: isError && isDatabaseError(value),
      keys: writtenKeys(value, errorLike),
    }
  } catch {
    return undefined
  }
}

/** What `failedQueryReach` found. */
export interface FailedQueryReach {
  /** Every error reached, each once, `root` first when it is one. */
  errors: Error[]
  /**
   * Whether a failed query may be in reach: a database error, any string
   * that carries a failed query's text (a message, a stack, a property, a
   * string `cause`), or a graph too deep, too large or too exotic to walk to
   * the end.
   */
  found: boolean
}

/**
 * Walk everything a log line could write from `root`, each value once:
 * `message`, `stack`, `cause` (enumerable or not) and `errors` of anything
 * with a string `message`, and the properties of errors, plain objects,
 * arrays and class instances alike (a class instance is written by
 * `JSON.stringify` as its own enumerable properties, so a failed query it
 * holds would be written too). Typed arrays and buffers hold only numbers and
 * are not entered. The walk stops `MAX_GRAPH_DEPTH` levels deep and after
 * `MAX_GRAPH_VALUES` values, and either stop counts as finding a failed query.
 */
export function failedQueryReach(root: unknown): FailedQueryReach {
  const errors: Error[] = []
  const seen = new Set<object>()
  let found = false
  let budget = MAX_GRAPH_VALUES
  const visit = (value: unknown, depth: number): void => {
    if (--budget < 0) {
      found = true
      return
    }
    if (typeof value === 'string') {
      if (value.includes(FAILED_QUERY_MARKER)) found = true
      return
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return
    if (depth > MAX_GRAPH_DEPTH) {
      found = true
      return
    }
    seen.add(value)
    if (ArrayBuffer.isView(value)) return
    const shape = nodeShape(value)
    if (shape === undefined) {
      found = true
      return
    }
    if (shape.isArray) {
      for (const item of value as unknown[]) {
        if (budget < 0) return
        visit(item, depth + 1)
      }
      return
    }
    if (shape.isError) errors.push(value as Error)
    if (shape.database) found = true
    if (shape.errorLike) {
      visit(readProperty(value, 'message'), depth + 1)
      visit(readProperty(value, 'stack'), depth + 1)
      visit(readProperty(value, 'cause'), depth + 1)
      visit(readProperty(value, 'errors'), depth + 1)
    }
    for (const key of shape.keys) {
      if (budget < 0) return
      visit(readProperty(value, key), depth + 1)
    }
  }
  visit(root, 0)
  return { errors, found }
}

/** Every error reachable from `root`, each once (see `failedQueryReach`). */
export function reachableErrors(root: unknown): Error[] {
  return failedQueryReach(root).errors
}

/**
 * Whether `error`, or anything reachable from it (see `failedQueryReach`),
 * is a failed database query or carries one's text: an app error built as
 * `Failed to ...: ${error.message}`, or a property or string `cause` that
 * holds such a message. A graph too deep or too large to walk counts as one.
 */
export function containsDatabaseError(error: unknown): boolean {
  return failedQueryReach(error).found
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
 * Which kind of failed query `error` is, read from its shape: drizzle-orm's
 * `DrizzleQueryError` or a postgres.js `PostgresError`. `undefined` for any
 * other error. The production server is bundled, and a bundler may rename a
 * class, so a label read from `constructor.name` or from postgres.js's
 * `this.name = this.constructor.name` could name a class that does not exist.
 */
export function databaseErrorKind(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const e = error as Error & { query?: unknown; params?: unknown }
  if (typeof e.query === 'string' && Array.isArray(e.params)) return 'DrizzleQueryError'
  if (typeof e.message === 'string' && e.message.startsWith(FAILED_QUERY_MARKER)) {
    return 'DrizzleQueryError'
  }
  return isDatabaseError(error) ? 'PostgresError' : undefined
}

/**
 * The name of an error's class for a log line: the shape-read kind for a
 * failed query (`databaseErrorKind`), else `name`, else the class name
 * (drizzle-orm 0.45 never sets `name` on DrizzleQueryError).
 */
export function errorClassName(error: Error): string {
  const kind = databaseErrorKind(error)
  if (kind) return kind
  return error.name !== 'Error' ? error.name : error.constructor?.name || error.name
}

/**
 * What may be logged about a failed query (DEF-63). A failed query's message
 * is `Failed query: <sql>\nparams: <params>`, its `params` (postgres.js:
 * `parameters`) are the bound values, and its Postgres cause can echo a value
 * in `message` or `detail`. Any of those can be a user's search text, an email
 * address or a token, so none of them is returned: only the SQLSTATE, the
 * error class, the parameterized statement, how many parameters it had, and
 * the Postgres identifiers above.
 */
export function databaseErrorLogFields(error: unknown): Record<string, string | number> {
  const fields: Record<string, string | number> = {}
  const code = postgresErrorCode(error)
  if (code) fields.pg_code = code
  if (error instanceof Error) fields.error_name = errorClassName(error)
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== 'object') break
    const e = current as Record<string, unknown>
    if (fields.statement === undefined && typeof e.query === 'string') fields.statement = e.query
    if (fields.param_count === undefined) {
      if (Array.isArray(e.params)) fields.param_count = e.params.length
      else if (Array.isArray(e.parameters)) fields.param_count = e.parameters.length
    }
    for (const [from, to] of SAFE_POSTGRES_FIELDS) {
      if (fields[to] === undefined && typeof e[from] === 'string') fields[to] = e[from] as string
    }
    current = e.cause
  }
  return fields
}
