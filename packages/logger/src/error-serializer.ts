/**
 * Error serialization for the shared logger (DEF-63).
 *
 * Pino's standard `err` serializer (pino-std-serializers 7.1) writes the
 * message with every cause's message appended, the stack with every cause's
 * stack appended, and every enumerable property. For a failed query that is
 * the SQL, every bound value (drizzle-orm's `DrizzleQueryError` holds them as
 * its enumerable `params` and in its message) and the Postgres error's
 * message and `detail`, which echo values too. Errors logged under any other
 * key are written by `JSON.stringify`, which prints the same enumerable
 * `params` and the whole `cause`.
 *
 * `serializeError` keeps the standard serializer for every error that has
 * nothing to do with a database. When a failed query is anywhere in reach (the
 * error itself, any depth of its cause chain, an aggregated error, an error in
 * one of its properties), it writes a redacted shape instead:
 *
 * - a database error becomes `databaseErrorLogFields` (SQLSTATE, class,
 *   parameterized statement, parameter count, Postgres identifiers), a fixed
 *   message, its stack frames without the message, and any non-database
 *   cause (a dropped connection, a timeout);
 * - any other error keeps its own message and stack, with the text of every
 *   failed query in reach replaced, and its cause serialized the same way
 *   rather than appended.
 *
 * `sanitizeLogFields` (pino's `formatters.log`) and `sanitizeLogArguments`
 * (pino's `hooks.logMethod`) route errors logged under other keys, nested in
 * plain objects, or passed as the first argument through the same rules, and
 * cut a failed query's text out of any logged string, including the message
 * pino derives from an error when the call gives none.
 */
import pino from 'pino'
import {
  FAILED_QUERY_MARKER,
  databaseErrorLogFields,
  isDatabaseError,
  isPlainObject,
  reachableErrors,
} from './database-error'

/** The message a database error is logged with in place of its own. */
export const DATABASE_ERROR_LOG_MESSAGE = 'database query failed'

/** What replaces a failed query's text in any other logged string. */
export const WITHHELD_QUERY_TEXT = '[failed query withheld]'

/** Pino's key for the error of a log call. */
const ERROR_KEY = 'err'

/** A V8 or Bun stack frame line. */
const FRAME = /^\s+at\s/

/**
 * Properties that hold a query's bound values: drizzle-orm `params`,
 * postgres.js `parameters` and `args` (enumerable when its `debug` is on).
 */
const BOUND_VALUE_KEYS = new Set(['params', 'parameters', 'args'])

/** Postgres error fields that can echo a value, withheld wherever they appear. */
const VALUE_BEARING_FIELDS = ['message', 'detail', 'where', 'hint', 'internal_query'] as const

/** Deepest cause chain or error nesting followed; real ones are a few levels deep. */
const MAX_DEPTH = 32

/** Deepest plain-object nesting of log fields that is inspected. */
const MAX_SANITIZE_DEPTH = 64

/** Shorter texts are not replaced, so a short Postgres field cannot garble a stack. */
const MIN_WITHHELD_LENGTH = 4

type ErrorLike = { message: string; stack?: unknown; constructor?: unknown; name?: unknown }

/** Pino's own test for an error: anything with a string `message`. */
function isErrorLike(value: unknown): value is ErrorLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}

/** Read one property without letting a throwing getter escape. */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** The `type` pino's serializer writes: the constructor's name, else `name`. */
function typeName(error: ErrorLike): string {
  const ctor = error.constructor
  if (typeof ctor === 'function' && ctor.name) return ctor.name
  return typeof error.name === 'string' ? error.name : 'Error'
}

/**
 * The texts to withhold for the failed queries among `errors` (which, from
 * `reachableErrors`, already include every cause): each database error's
 * message and the Postgres fields that echo values. Longest first, so a
 * message is replaced before a shorter text inside it. A non-database cause,
 * such as a dropped connection, keeps its message.
 */
function withheldTexts(errors: Error[]): string[] {
  const texts = new Set<string>()
  for (const error of errors) {
    if (!isDatabaseError(error)) continue
    for (const field of VALUE_BEARING_FIELDS) {
      const text = readProperty(error, field)
      if (typeof text === 'string' && text.length >= MIN_WITHHELD_LENGTH) texts.add(text)
    }
  }
  return [...texts].sort((a, b) => b.length - a.length)
}

/** `text` with every withheld text replaced, and cut at a failed query's text. */
function scrubText(text: string, withheld: readonly string[]): string {
  let out = text
  for (const secret of withheld) {
    if (out.includes(secret)) out = out.split(secret).join(WITHHELD_QUERY_TEXT)
  }
  const at = out.indexOf(FAILED_QUERY_MARKER)
  return at === -1 ? out : out.slice(0, at) + WITHHELD_QUERY_TEXT
}

/**
 * A stack with every withheld text replaced. A failed query's text that is
 * still there (a message built from one whose error was not kept) is cut up
 * to the stack frames that follow it.
 */
function scrubStack(stack: string, withheld: readonly string[]): string {
  let out = stack
  for (const secret of withheld) {
    if (out.includes(secret)) out = out.split(secret).join(WITHHELD_QUERY_TEXT)
  }
  const at = out.indexOf(FAILED_QUERY_MARKER)
  if (at === -1) return out
  const frames = out
    .slice(at)
    .split('\n')
    .filter((line) => FRAME.test(line))
  return [out.slice(0, at) + WITHHELD_QUERY_TEXT, ...frames].join('\n')
}

/**
 * A database error's stack frames under a fixed header. The header of
 * `stack` repeats the message (the query and its values), so only the frame
 * lines after the message are kept. When the message cannot be found in the
 * stack, the stack is left out rather than guessed at.
 */
function databaseErrorStack(
  error: Error,
  type: string,
  withheld: readonly string[]
): string | undefined {
  const stack = readProperty(error, 'stack')
  if (typeof stack !== 'string' || stack === '') return undefined
  const message = typeof error.message === 'string' ? error.message : ''
  const start = message ? stack.indexOf(message) : 0
  if (start === -1) return undefined
  const frames = stack
    .slice(start + message.length)
    .split('\n')
    .filter(
      (line) =>
        FRAME.test(line) &&
        !line.includes(FAILED_QUERY_MARKER) &&
        !withheld.some((secret) => line.includes(secret))
    )
  return frames.length > 0
    ? [`${type}: ${DATABASE_ERROR_LOG_MESSAGE}`, ...frames].join('\n')
    : undefined
}

interface RedactionContext {
  withheld: readonly string[]
  seen: Set<object>
}

/**
 * The first cause below a database error that is not a database error
 * itself, such as the dropped connection or timeout a query failed on. It
 * says why the query failed without carrying the query's values.
 */
function firstNonDatabaseCause(error: Error): ErrorLike | undefined {
  let current = readProperty(error, 'cause')
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (!isErrorLike(current)) return undefined
    if (!isDatabaseError(current)) return current
    current = readProperty(current, 'cause')
  }
  return undefined
}

function serializeDatabaseError(
  error: Error,
  context: RedactionContext,
  depth: number
): Record<string, unknown> {
  const type = typeName(error)
  const out: Record<string, unknown> = {
    type,
    message: DATABASE_ERROR_LOG_MESSAGE,
    ...databaseErrorLogFields(error),
  }
  const stack = databaseErrorStack(error, type, context.withheld)
  if (stack) out.stack = stack
  const cause = firstNonDatabaseCause(error)
  if (cause) {
    const serialized = serializeRedacted(cause, context, depth + 1)
    if (serialized) out.cause = serialized
  }
  return out
}

/** A value inside a redacted error: strings scrubbed, errors redacted. */
function redactValue(value: unknown, context: RedactionContext, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value, context.withheld)
  if (value === null || typeof value !== 'object') return value
  if (isErrorLike(value) && (value instanceof Error || !isPlainObject(value))) {
    return serializeRedacted(value, context, depth)
  }
  if (depth > MAX_DEPTH || context.seen.has(value)) return undefined
  if (Array.isArray(value)) {
    context.seen.add(value)
    return value.map((item) => redactValue(item, context, depth + 1))
  }
  if (!isPlainObject(value)) return value
  context.seen.add(value)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (BOUND_VALUE_KEYS.has(key)) continue
    out[key] = redactValue(readProperty(value, key), context, depth + 1)
  }
  return out
}

/**
 * Serialize an error that has a failed query in reach. Mirrors pino's
 * serializer (type, message, stack, aggregated errors, enumerable
 * properties), except that a database error is reduced to its safe fields,
 * every other message and stack is scrubbed, bound-value properties are
 * dropped, and the cause is serialized under `cause` instead of being
 * appended to the message and stack.
 */
function serializeRedacted(
  error: ErrorLike,
  context: RedactionContext,
  depth: number
): Record<string, unknown> | undefined {
  if (depth > MAX_DEPTH || context.seen.has(error)) return undefined
  context.seen.add(error)
  if (isDatabaseError(error)) return serializeDatabaseError(error as Error, context, depth)

  const out: Record<string, unknown> = {
    type: typeName(error),
    message: scrubText(error.message, context.withheld),
  }
  const stack = readProperty(error, 'stack')
  if (typeof stack === 'string') out.stack = scrubStack(stack, context.withheld)
  const aggregated = readProperty(error, 'errors')
  if (Array.isArray(aggregated)) {
    out.aggregateErrors = aggregated.map((item) => redactValue(item, context, depth + 1))
  }
  // Enumerable properties, own and inherited, as pino's serializer reads them.
  for (const key in error) {
    if (out[key] !== undefined || key === 'cause' || key === 'errors') continue
    if (BOUND_VALUE_KEYS.has(key)) continue
    out[key] = redactValue(readProperty(error, key), context, depth + 1)
  }
  const cause = readProperty(error, 'cause')
  if (cause !== undefined) {
    const serialized = redactValue(cause, context, depth + 1)
    if (serialized !== undefined) out.cause = serialized
  }
  return out
}

/** Whether a failed query is in reach of `error`, or its text is in its message. */
function touchesDatabase(error: ErrorLike, reachable: Error[]): boolean {
  if (error.message.includes(FAILED_QUERY_MARKER)) return true
  return reachable.some(
    (e) =>
      isDatabaseError(e) ||
      (typeof e.message === 'string' && e.message.includes(FAILED_QUERY_MARKER))
  )
}

/**
 * Pino `err` serializer. Any error with a failed query in reach gets the
 * redacted shape described above; every other error gets pino's standard
 * serializer, unchanged. A value that is not an error is passed through
 * `sanitizeLogValue`.
 */
export function serializeError(value: unknown): unknown {
  if (!isErrorLike(value)) return sanitizeLogValue(value)
  const reachable = reachableErrors(value)
  if (!touchesDatabase(value, reachable)) return pino.stdSerializers.err(value as Error)
  const context: RedactionContext = { withheld: withheldTexts(reachable), seen: new Set() }
  return serializeRedacted(value, context, 0)
}

/**
 * The message pino writes for a log call that passes an error and no message
 * of its own: a fixed text for a database error, the error's own message
 * with any failed query's text withheld otherwise.
 */
export function errorLogMessage(error: unknown): string | undefined {
  if (!isErrorLike(error)) return undefined
  if (isDatabaseError(error)) return DATABASE_ERROR_LOG_MESSAGE
  return scrubText(error.message, withheldTexts(reachableErrors(error)))
}

/** Marks a plain object or array whose sanitized copy is still being built. */
const IN_PROGRESS = Symbol('sanitizing')

/**
 * A logged value made safe: an error anywhere inside plain objects and arrays
 * goes through `serializeError`, and a string that carries a failed query's
 * text is cut there. Returns `value` itself when nothing needed changing, so
 * ordinary log lines are not copied. A plain object or array that contains
 * itself is written as `[Circular]` where it repeats, as pino would.
 */
export function sanitizeLogValue(
  value: unknown,
  depth = 0,
  memo: Map<object, unknown> = new Map()
): unknown {
  if (typeof value === 'string') {
    return value.includes(FAILED_QUERY_MARKER) ? scrubText(value, []) : value
  }
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) return serializeError(value)
  if (!Array.isArray(value) && !isPlainObject(value)) return value
  if (memo.has(value)) {
    const done = memo.get(value)
    return done === IN_PROGRESS ? '[Circular]' : done
  }
  if (depth >= MAX_SANITIZE_DEPTH) return value
  memo.set(value, IN_PROGRESS)
  let result: unknown = value
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined
    for (let index = 0; index < value.length; index++) {
      const item: unknown = value[index]
      const clean = sanitizeLogValue(item, depth + 1, memo)
      if (clean !== item) {
        copy ??= value.slice()
        copy[index] = clean
      }
    }
    if (copy) result = copy
  } else {
    let copy: Record<string, unknown> | undefined
    for (const key of Object.keys(value)) {
      const item = readProperty(value, key)
      const clean = sanitizeLogValue(item, depth + 1, memo)
      if (clean !== item) {
        copy ??= { ...value }
        copy[key] = clean
      }
    }
    if (copy) result = copy
  }
  memo.set(value, result)
  return result
}

/**
 * Pino `formatters.log`: every field but `err` (which the `err` serializer
 * handles) through `sanitizeLogValue`.
 */
export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined
  for (const key of Object.keys(fields)) {
    if (key === ERROR_KEY) continue
    const value = fields[key]
    const clean = sanitizeLogValue(value)
    if (clean !== value) {
      copy ??= { ...fields }
      copy[key] = clean
    }
  }
  return copy ?? fields
}

/**
 * Pino `hooks.logMethod` arguments made safe. When a call passes an error (as
 * the first argument, or as `err`) and no message, pino would log the error's
 * own message, so the call is given `errorLogMessage` instead. A message or
 * format argument that carries a failed query's text is cut there.
 */
export function sanitizeLogArguments(args: readonly unknown[]): unknown[] {
  const out = args.map((arg) =>
    typeof arg === 'string' && arg.includes(FAILED_QUERY_MARKER) ? scrubText(arg, []) : arg
  )
  if (out.length === 1) {
    const [first] = out
    let error: unknown
    if (first instanceof Error) error = first
    else if (first !== null && typeof first === 'object') {
      const fields = first as Record<string, unknown>
      if (fields.msg === undefined) error = fields[ERROR_KEY]
    }
    if (error !== undefined && isErrorLike(error)) {
      const reachable = reachableErrors(error)
      if (touchesDatabase(error, reachable)) {
        const message = errorLogMessage(error)
        if (message !== undefined) out.push(message)
      }
    }
  }
  return out
}
