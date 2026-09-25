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
 * one of its properties or in a class instance it holds) or its text is (in a
 * message, a stack, a string property or a string cause), it writes a redacted
 * shape instead (`failedQueryReach` in ./database-error.ts decides):
 *
 * - a database error becomes `databaseErrorLogFields` (SQLSTATE, class,
 *   parameterized statement, parameter count, Postgres identifiers), a fixed
 *   message, its stack frames without the message, and any non-database
 *   cause (a dropped connection, a timeout);
 * - any other error keeps its own message and stack, with the text of every
 *   failed query in reach replaced, and its cause serialized the same way
 *   rather than appended; a class instance it holds is written as
 *   `JSON.stringify` would write it, redacted the same way.
 *
 * `sanitizeLogFields` (pino's `formatters.log` and `formatters.bindings`, and
 * the logger's child bindings) and `sanitizeLogArguments` (pino's
 * `hooks.logMethod`) route errors logged under other keys, nested in plain
 * objects or class instances, bound to a child logger, passed as the first
 * argument or as a printf argument through the same rules, and cut a failed
 * query's text out of any logged string, including the message pino derives
 * from an error when the call gives none. `scrubLogLine` (pino's
 * `hooks.streamWrite`) is the last layer: it cuts a failed query's text out of
 * the finished line, whatever wrote it there.
 *
 * A database error's `type` is read from its shape (`databaseErrorKind`), not
 * its class name, because the production server is bundled.
 */
import pino from 'pino'
import {
  FAILED_QUERY_MARKER,
  databaseErrorLogFields,
  errorClassName,
  failedQueryReach,
  isDatabaseError,
  isPlainObject,
} from './database-error'

/** The message a database error is logged with in place of its own. */
export const DATABASE_ERROR_LOG_MESSAGE = 'database query failed'

/** What replaces a failed query's text in any other logged string. */
export const WITHHELD_QUERY_TEXT = '[failed query withheld]'

/** What a value that cannot be read or converted is written as. */
const UNSERIALIZABLE = '[unserializable]'

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

/**
 * How many values one redacted error may write. A larger graph (an error that
 * holds a client or a socket) is written up to here, and the rest as
 * `TRUNCATED`, so the redacted copy is never larger than a readable line.
 */
const MAX_REDACTED_VALUES = 10_000

/** What a value past `MAX_REDACTED_VALUES` is written as. */
const TRUNCATED = '[truncated]'

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
 * `failedQueryReach`, already include every cause): each database error's
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

/** `text` with every withheld text replaced. */
function replaceWithheld(text: string, withheld: readonly string[]): string {
  let out = text
  for (const secret of withheld) {
    if (out.includes(secret)) out = out.split(secret).join(WITHHELD_QUERY_TEXT)
  }
  return out
}

/** `text` with every withheld text replaced, and cut at a failed query's text. */
function scrubText(text: string, withheld: readonly string[]): string {
  const out = replaceWithheld(text, withheld)
  const at = out.indexOf(FAILED_QUERY_MARKER)
  return at === -1 ? out : out.slice(0, at) + WITHHELD_QUERY_TEXT
}

/**
 * The frames of `stack` when it is provably the error's own: the error's
 * `message` starts on its first line, and every line after the message is a
 * stack frame, as V8 and Bun write them. `undefined` when either does not
 * hold, such as for a stack the app rewrote.
 */
function framesAfterMessage(
  stack: string,
  message: string
): { head: string; frames: string } | undefined {
  if (message === '') return undefined
  const start = stack.indexOf(message)
  if (start === -1 || stack.slice(0, start).includes('\n')) return undefined
  const end = start + message.length
  const frames = stack.slice(end)
  const [first, ...rest] = frames.split('\n')
  if (first !== '' || !rest.every((line) => FRAME.test(line))) return undefined
  return { head: stack.slice(0, end), frames }
}

/**
 * A stack with every withheld text replaced. A failed query's text that is
 * still there (a message built from one whose error is out of reach) carries
 * bound values, which can hold anything, including text shaped like a stack
 * frame (drizzle-orm joins them with commas: `params: x\n    at y`). So
 * nothing after that text is kept unless it is provably a frame: when the
 * stack is the error's own (`framesAfterMessage`), the header is cut at the
 * failed query's text and the frames after the message are kept. Otherwise
 * the stack is cut there and nothing after it is kept.
 */
function scrubStack(stack: string, message: string, withheld: readonly string[]): string {
  const out = replaceWithheld(stack, withheld)
  const at = out.indexOf(FAILED_QUERY_MARKER)
  if (at === -1) return out
  const own = framesAfterMessage(stack, message)
  if (own) {
    const frames = replaceWithheld(own.frames, withheld)
    if (!frames.includes(FAILED_QUERY_MARKER)) return scrubText(own.head, withheld) + frames
  }
  return out.slice(0, at) + WITHHELD_QUERY_TEXT
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
  /** Values still to be written (`MAX_REDACTED_VALUES`). */
  budget: number
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
  // Read from the error's shape, not its class name, which a bundler may rename.
  const type = errorClassName(error)
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
  if (--context.budget < 0) return TRUNCATED
  if (typeof value === 'string') return scrubText(value, context.withheld)
  if (value === null || typeof value !== 'object') return value
  if (isErrorLike(value) && (value instanceof Error || !isPlainObject(value))) {
    return serializeRedacted(value, context, depth)
  }
  if (depth > MAX_DEPTH || context.seen.has(value)) return undefined
  context.seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, context, depth + 1))
  if (!isPlainObject(value)) return redactInstance(value, context, depth)
  return redactProperties(value, context, depth)
}

/**
 * The own enumerable properties of `value`, the ones `JSON.stringify` writes,
 * redacted, without the properties that hold a query's bound values.
 */
function redactProperties(
  value: object,
  context: RedactionContext,
  depth: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (BOUND_VALUE_KEYS.has(key)) continue
    out[key] = redactValue(readProperty(value, key), context, depth + 1)
  }
  return out
}

/**
 * A class instance inside a redacted value, written as `JSON.stringify` would
 * write it (its `toJSON` result, else its own enumerable properties), then
 * redacted. A date, a typed array and a buffer carry no text and are kept.
 */
function redactInstance(value: object, context: RedactionContext, depth: number): unknown {
  try {
    if (value instanceof Date || ArrayBuffer.isView(value)) return value
    const toJSON = readProperty(value, 'toJSON')
    if (typeof toJSON === 'function') {
      return redactValue(toJSON.call(value), context, depth + 1)
    }
    return redactProperties(value, context, depth)
  } catch {
    return UNSERIALIZABLE
  }
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
  if (typeof stack === 'string') out.stack = scrubStack(stack, error.message, context.withheld)
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

/**
 * Pino `err` serializer. Any error with a failed query or its text in reach
 * (`failedQueryReach`) gets the redacted shape described above; every other
 * error gets pino's standard serializer, unchanged. A value that is not an
 * error is passed through `sanitizeLogValue`.
 */
export function serializeError(value: unknown): unknown {
  if (!isErrorLike(value)) return sanitizeLogValue(value)
  const reach = failedQueryReach(value)
  if (!reach.found) return pino.stdSerializers.err(value as Error)
  return serializeRedacted(value, redactionContext(reach.errors), 0)
}

function redactionContext(errors: Error[]): RedactionContext {
  return { withheld: withheldTexts(errors), seen: new Set(), budget: MAX_REDACTED_VALUES }
}

/** `errorLogMessage` for an error whose reachable errors are already known. */
function messageFor(error: ErrorLike, reachable: Error[]): string {
  if (isDatabaseError(error)) return DATABASE_ERROR_LOG_MESSAGE
  return scrubText(error.message, withheldTexts(reachable))
}

/**
 * The message pino writes for a log call that passes an error and no message
 * of its own: a fixed text for a database error, the error's own message
 * with any failed query's text withheld otherwise.
 */
export function errorLogMessage(error: unknown): string | undefined {
  if (!isErrorLike(error)) return undefined
  return messageFor(error, failedQueryReach(error).errors)
}

/** Marks a plain object or array whose sanitized copy is still being built. */
const IN_PROGRESS = Symbol('sanitizing')

/**
 * A logged value made safe: an error anywhere inside plain objects and arrays
 * goes through `serializeError`, a class instance with a failed query or its
 * text in reach is written redacted (`sanitizeInstance`), and a string that
 * carries a failed query's text is cut there. Returns `value` itself when
 * nothing needed changing, so ordinary log lines are not copied. A plain
 * object or array that contains itself is written as `[Circular]` where it
 * repeats, as pino would.
 */
export function sanitizeLogValue(value: unknown): unknown {
  return sanitizeNested(value, 0, undefined)
}

/**
 * `sanitizeLogValue` with its recursion state. The memo is created only when
 * a plain object or array is walked, so the strings and numbers that make up
 * most log fields cost no allocation.
 */
function sanitizeNested(
  value: unknown,
  depth: number,
  memoIn: Map<object, unknown> | undefined
): unknown {
  if (typeof value === 'string') {
    return value.includes(FAILED_QUERY_MARKER) ? scrubText(value, []) : value
  }
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) return serializeError(value)
  if (!Array.isArray(value) && !isPlainObject(value)) return sanitizeInstance(value)
  const memo = memoIn ?? new Map<object, unknown>()
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
      const clean = sanitizeNested(item, depth + 1, memo)
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
      const clean = sanitizeNested(item, depth + 1, memo)
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
 * A class instance among the logged values. `JSON.stringify` writes its own
 * enumerable properties (or its `toJSON` result), so a failed query it holds,
 * or a string with a failed query's text, would be written as it is. It is
 * kept as it is unless `failedQueryReach` finds one, and then written as
 * `redactInstance` writes it (an error-like one as a redacted error).
 */
function sanitizeInstance(value: object): unknown {
  const reach = failedQueryReach(value)
  if (!reach.found) return value
  return redactValue(value, redactionContext(reach.errors), 0)
}

/**
 * Pino `formatters.log` and `formatters.bindings`, and the logger's child
 * bindings: every field but `err` (which the `err` serializer handles, in
 * bindings too) through `sanitizeLogValue`.
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
 * A message or printf argument (anything after the first argument) made safe.
 * Pino formats these with quick-format-unescaped, which writes `%s` with
 * `String()` and `%o`, `%O` and `%j` with `JSON.stringify`, so neither goes
 * through the `err` serializer: an error with a failed query in reach becomes
 * `errorLogMessage`, and a plain object or array goes through
 * `sanitizeLogValue`. Any other error is left as it is, so `%s` still prints
 * its message.
 */
function sanitizeMessageArgument(arg: unknown): unknown {
  if (typeof arg === 'string') {
    return arg.includes(FAILED_QUERY_MARKER) ? scrubText(arg, []) : arg
  }
  if (arg === null || typeof arg !== 'object') return arg
  if (isErrorLike(arg) && (arg instanceof Error || !isPlainObject(arg))) {
    const reach = failedQueryReach(arg)
    return reach.found ? messageFor(arg, reach.errors) : arg
  }
  return sanitizeLogValue(arg)
}

/**
 * Pino `hooks.logMethod` arguments made safe. When a call passes an error (as
 * the first argument, or as `err`) and no message, or `undefined` as the
 * message (with or without format arguments after it), pino would log the
 * error's own message, so the call is given `errorLogMessage` instead. A
 * message or format argument that carries a failed query's text is cut there
 * (`sanitizeMessageArgument`).
 */
export function sanitizeLogArguments(args: readonly unknown[]): unknown[] {
  // The first argument is the merging object or error (the serializer and
  // `formatters.log` handle those) or the message string.
  const out = args.map((arg, index) => {
    if (index > 0) return sanitizeMessageArgument(arg)
    return typeof arg === 'string' && arg.includes(FAILED_QUERY_MARKER) ? scrubText(arg, []) : arg
  })
  // pino reads the message from the error whenever the call's own message is
  // `undefined`: absent (`log.error(err)`) or passed as such, whatever follows
  // it (`log.error(err, undefined, value)` formats to `undefined` too).
  if (out[1] !== undefined) return out
  const [first] = out
  let error: unknown
  if (first instanceof Error) error = first
  else if (first !== null && typeof first === 'object') {
    const fields = first as Record<string, unknown>
    if (fields.msg === undefined) error = fields[ERROR_KEY]
  }
  if (error !== undefined && isErrorLike(error)) {
    const reach = failedQueryReach(error)
    if (reach.found) out[1] = messageFor(error, reach.errors)
  }
  return out
}

/**
 * Pino `hooks.streamWrite`: the last layer, applied to each finished line.
 * Whatever the layers above did not reach (a `toJSON` result, a binding a
 * caller's own bindings formatter made, a VError-style cause function), no
 * line leaves with a failed query's text in it: every JSON string that holds
 * one is cut there, as `scrubText` cuts a string. Pino writes every string
 * with JSON escapes, so the string ends at the next unescaped quote, and the
 * line stays valid JSON.
 */
export function scrubLogLine(line: string): string {
  let at = line.indexOf(FAILED_QUERY_MARKER)
  if (at === -1) return line
  let out = ''
  let from = 0
  while (at !== -1) {
    let end = at + FAILED_QUERY_MARKER.length
    while (end < line.length && line[end] !== '"') end += line[end] === '\\' ? 2 : 1
    out += line.slice(from, at) + WITHHELD_QUERY_TEXT
    from = end
    at = line.indexOf(FAILED_QUERY_MARKER, end)
  }
  return out + line.slice(from)
}
