/**
 * DEF-63: a failed query never reaches a log line with its bound values.
 *
 * Every case logs through the real `createLogger` into a capture stream and
 * inspects the emitted JSON, so the serializer, the `formatters.log` pass, the
 * `logMethod` hook and the redact paths are all exercised together, as they
 * run in production. The errors are built with the shapes drizzle-orm 0.45.2
 * and postgres.js 3.4 give them (this package does not depend on either; the
 * web app's logger-database-error test uses the real classes).
 */
import { describe, expect, it } from 'vitest'
import { createLogger } from '../logger'
import { DATABASE_ERROR_LOG_MESSAGE, WITHHELD_QUERY_TEXT } from '../error-serializer'

/** drizzle-orm 0.45.2 `DrizzleQueryError`, constructor copied as it is. */
class DrizzleQueryError extends Error {
  query: string
  params: unknown[]
  constructor(query: string, params: unknown[], cause?: Error) {
    super(`Failed query: ${query}\nparams: ${params}`)
    this.query = query
    this.params = params
    this.cause = cause
    Error.captureStackTrace(this, DrizzleQueryError)
    if (cause) this.cause = cause
  }
}

/** postgres.js 3.4 `PostgresError`: the server's fields copied onto the error. */
class PostgresError extends Error {
  constructor(fields: Record<string, string>) {
    super(fields.message)
    this.name = this.constructor.name
    Object.assign(this, fields)
  }
}

/** An app error that carries its cause, as the web app's DomainException does. */
class AppError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }
}

const SECRET_PARAM = 'tok_live_SECRET_4242'
const SECRET_EMAIL = 'ann@acme.example'
const SEARCH_TEXT = 'my private search words'
const PG_MESSAGE = `invalid input syntax for type uuid: "${SECRET_PARAM}"`
const PG_DETAIL = `Key (email)=(${SECRET_EMAIL}) already exists.`
const STATEMENT = 'select "id" from "posts" where "title" ilike $1 and "author_email" = $2'

/** Texts that must never appear anywhere in an emitted line. */
const SECRETS = [SECRET_PARAM, SECRET_EMAIL, SEARCH_TEXT, PG_MESSAGE, 'already exists', 'params:']

/** `debug`: postgres.js makes the query and its values enumerable. */
function postgresError(debug = false): PostgresError {
  const error = new PostgresError({
    message: PG_MESSAGE,
    severity: 'ERROR',
    severity_local: 'ERROR',
    code: '22P02',
    detail: PG_DETAIL,
    routine: 'string_to_uuid',
    table_name: 'posts',
    column_name: 'author_id',
  })
  // postgres.js queryError(): query and values ride on the error, hidden
  // unless the client's `debug` option is on.
  Object.defineProperties(error, {
    query: { value: STATEMENT, enumerable: debug },
    parameters: { value: [SEARCH_TEXT, SECRET_EMAIL], enumerable: debug },
    args: { value: [SEARCH_TEXT, SECRET_EMAIL], enumerable: debug },
  })
  return error
}

function failedQuery(cause: Error = postgresError()): DrizzleQueryError {
  return new DrizzleQueryError(STATEMENT, [SEARCH_TEXT, SECRET_EMAIL, SECRET_PARAM], cause)
}

function capture() {
  const lines: string[] = []
  const log = createLogger({ level: 'trace', destination: { write: (s: string) => lines.push(s) } })
  return {
    log,
    lines,
    last: () => JSON.parse(lines[lines.length - 1]),
  }
}

function expectNoSecrets(line: string) {
  for (const secret of SECRETS) expect(line).not.toContain(secret)
  expect(line).not.toContain('Failed query')
}

describe('err serializer: database errors (DEF-63)', () => {
  it('reduces a bare failed query to its statement, SQLSTATE and identifiers', () => {
    const sink = capture()
    sink.log.error({ err: failedQuery() }, 'search failed')

    expectNoSecrets(sink.lines[0])
    const { err, msg } = sink.last()
    expect(msg).toBe('search failed')
    expect(err).toMatchObject({
      type: 'DrizzleQueryError',
      message: DATABASE_ERROR_LOG_MESSAGE,
      pg_code: '22P02',
      error_name: 'DrizzleQueryError',
      statement: STATEMENT,
      param_count: 3,
      severity: 'ERROR',
      routine: 'string_to_uuid',
      table: 'posts',
      column: 'author_id',
    })
    expect(err.params).toBeUndefined()
    expect(err.cause).toBeUndefined()
  })

  it('keeps the stack frames of a failed query but not its message', () => {
    const sink = capture()
    sink.log.error({ err: failedQuery() }, 'search failed')

    const { err } = sink.last()
    expect(typeof err.stack).toBe('string')
    expect(err.stack.startsWith(`DrizzleQueryError: ${DATABASE_ERROR_LOG_MESSAGE}\n`)).toBe(true)
    expect(err.stack).toMatch(/\n\s+at /)
  })

  it('withholds the cause of an app error that wraps a failed query', () => {
    const db = failedQuery()
    const sink = capture()
    sink.log.error({ err: new AppError('Search is unavailable', db) }, 'search failed')

    expectNoSecrets(sink.lines[0])
    const { err } = sink.last()
    expect(err.type).toBe('AppError')
    expect(err.message).toBe('Search is unavailable')
    expect(err.cause).toMatchObject({ type: 'DrizzleQueryError', pg_code: '22P02' })
  })

  it('withholds a failed query copied into an app error message', () => {
    const db = failedQuery()
    const sink = capture()
    sink.log.error({ err: new AppError(`Failed to list posts: ${db.message}`, db) }, 'list failed')

    expectNoSecrets(sink.lines[0])
    const { err } = sink.last()
    expect(err.message).toBe(`Failed to list posts: ${WITHHELD_QUERY_TEXT}`)
    expect(err.stack).toContain(`Failed to list posts: ${WITHHELD_QUERY_TEXT}`)
  })

  it('cuts a failed query out of an app error even when the query error was dropped', () => {
    const db = failedQuery()
    const sink = capture()
    sink.log.error({ err: new AppError(`Failed to list posts: ${db.message}`) }, 'list failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last().err.message).toBe(`Failed to list posts: ${WITHHELD_QUERY_TEXT}`)
  })

  it('reduces a postgres.js error, with or without its debug fields enumerable', () => {
    for (const debug of [false, true]) {
      const sink = capture()
      sink.log.error({ err: postgresError(debug) }, 'query failed')

      expectNoSecrets(sink.lines[0])
      expect(sink.last().err).toMatchObject({
        type: 'PostgresError',
        pg_code: '22P02',
        statement: STATEMENT,
        param_count: 2,
      })
    }
  })

  it('reduces a postgres.js error logged as the only argument', () => {
    const sink = capture()
    sink.log.error(postgresError(true))

    expectNoSecrets(sink.lines[0])
    expect(sink.last()).toMatchObject({
      msg: DATABASE_ERROR_LOG_MESSAGE,
      err: { type: 'PostgresError', pg_code: '22P02' },
    })
  })

  it('keeps a connection failure behind a failed query', () => {
    const dropped = Object.assign(new Error('write CONNECTION_CLOSED db.internal:5432'), {
      code: 'CONNECTION_CLOSED',
    })
    const sink = capture()
    sink.log.error({ err: failedQuery(dropped) }, 'query failed')

    expectNoSecrets(sink.lines[0])
    const { err } = sink.last()
    expect(err.cause).toMatchObject({
      message: 'write CONNECTION_CLOSED db.internal:5432',
      code: 'CONNECTION_CLOSED',
    })
  })

  it('withholds failed queries inside an AggregateError', () => {
    const sink = capture()
    sink.log.error({ err: new AggregateError([failedQuery()], 'batch failed') }, 'batch failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last().err.aggregateErrors[0]).toMatchObject({ pg_code: '22P02' })
  })

  it('survives a cause chain that loops', () => {
    const outer = new AppError('outer')
    const db = failedQuery(outer)
    ;(outer as { cause?: unknown }).cause = db
    const sink = capture()
    sink.log.error({ err: outer }, 'loop')

    expectNoSecrets(sink.lines[0])
    expect(sink.last().err.message).toBe('outer')
  })
})

describe('messages pino derives from an error (DEF-63)', () => {
  it('logs a fixed message for a failed query passed as the only argument', () => {
    const sink = capture()
    sink.log.error(failedQuery())

    expectNoSecrets(sink.lines[0])
    expect(sink.last().msg).toBe(DATABASE_ERROR_LOG_MESSAGE)
    expect(sink.last().err.pg_code).toBe('22P02')
  })

  it('logs a fixed message for { err } without a message', () => {
    const sink = capture()
    sink.log.warn({ err: failedQuery(), post_id: 'post_1' })

    expectNoSecrets(sink.lines[0])
    expect(sink.last()).toMatchObject({ msg: DATABASE_ERROR_LOG_MESSAGE, post_id: 'post_1' })
  })

  it("logs an app error's own message, with the failed query cut out", () => {
    const db = failedQuery()
    const sink = capture()
    sink.log.error(new AppError(`Failed to list posts: ${db.message}`, db))

    expectNoSecrets(sink.lines[0])
    expect(sink.last().msg).toBe(`Failed to list posts: ${WITHHELD_QUERY_TEXT}`)
  })

  it('cuts a failed query out of a message string', () => {
    const sink = capture()
    sink.log.error(`lookup failed: ${failedQuery().message}`)

    expectNoSecrets(sink.lines[0])
    expect(sink.last().msg).toBe(`lookup failed: ${WITHHELD_QUERY_TEXT}`)
  })

  it('logs a fixed message when the message passed is undefined', () => {
    // pino falls back to the error's own message for an undefined message,
    // not only for an absent one.
    const message: string | undefined = undefined
    const sink = capture()
    sink.log.error({ err: failedQuery() }, message)
    sink.log.error(failedQuery(), message)

    for (const line of sink.lines) expectNoSecrets(line)
    expect(sink.lines.map((l) => JSON.parse(l).msg)).toEqual([
      DATABASE_ERROR_LOG_MESSAGE,
      DATABASE_ERROR_LOG_MESSAGE,
    ])
  })

  it('withholds failed queries passed as printf arguments', () => {
    // quick-format-unescaped writes %s with String() and %j / %o with
    // JSON.stringify, neither of which reaches the err serializer.
    const sink = capture()
    sink.log.error('lookup failed: %s', failedQuery())
    sink.log.error('lookup failed: %j', failedQuery())
    sink.log.error({ post_id: 'post_1' }, 'lookup failed: %o', { reason: failedQuery() })
    sink.log.error('lookup failed: %s', new AppError('Search is unavailable', failedQuery()))

    for (const line of sink.lines) expectNoSecrets(line)
    const messages = sink.lines.map((l) => JSON.parse(l).msg as string)
    expect(messages[0]).toBe(`lookup failed: ${DATABASE_ERROR_LOG_MESSAGE}`)
    expect(messages[1]).toBe(`lookup failed: '${DATABASE_ERROR_LOG_MESSAGE}'`)
    expect(messages[2]).toContain('"pg_code":"22P02"')
    expect(messages[3]).toBe('lookup failed: Search is unavailable')
  })

  it('leaves printf arguments unrelated to a database as they were', () => {
    const sink = capture()
    sink.log.error('lookup failed: %s (%d tries)', new Error('boom'), 3)

    expect(sink.last().msg).toBe('lookup failed: Error: boom (3 tries)')
  })
})

describe('labels a bundler cannot change (DEF-63)', () => {
  // The production server is bundled, and a bundler may rename a class. These
  // subclasses stand in for the renamed classes: same shapes, other names.
  class RenamedQueryError extends DrizzleQueryError {}
  class RenamedPostgresError extends PostgresError {}

  it('names a failed query by its shape, not its class name', () => {
    const pg = new RenamedPostgresError({
      message: PG_MESSAGE,
      severity: 'ERROR',
      code: '22P02',
      detail: PG_DETAIL,
    })
    const db = new RenamedQueryError(STATEMENT, [SEARCH_TEXT, SECRET_EMAIL], pg)
    const sink = capture()
    sink.log.error({ err: db, pg }, 'failed')

    expectNoSecrets(sink.lines[0])
    const rec = sink.last()
    expect(pg.name).toBe('RenamedPostgresError')
    expect(rec.err).toMatchObject({ type: 'DrizzleQueryError', error_name: 'DrizzleQueryError' })
    expect(rec.err.stack.startsWith(`DrizzleQueryError: ${DATABASE_ERROR_LOG_MESSAGE}\n`)).toBe(
      true
    )
    expect(rec.pg).toMatchObject({
      type: 'PostgresError',
      error_name: 'PostgresError',
      pg_code: '22P02',
    })
  })
})

describe('errors under other keys (DEF-63)', () => {
  it.each(['error', 'cause', 'e', 'reason', 'dbError'])('serializes `%s` like err', (key) => {
    const sink = capture()
    sink.log.error({ [key]: failedQuery() }, 'failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last()[key]).toMatchObject({ type: 'DrizzleQueryError', pg_code: '22P02' })
  })

  it('serializes failed queries nested in plain objects and arrays', () => {
    const sink = capture()
    sink.log.error({ batch: { failures: [{ id: 'post_1', error: failedQuery() }] } }, 'failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last().batch.failures[0]).toMatchObject({
      id: 'post_1',
      error: { pg_code: '22P02' },
    })
  })

  it('serializes an object that holds a failed query twice, and one that loops', () => {
    const shared = { error: failedQuery() }
    const looped: Record<string, unknown> = { error: failedQuery() }
    looped.self = looped
    const sink = capture()
    sink.log.error({ a: shared, b: shared, looped }, 'failed')

    expectNoSecrets(sink.lines[0])
    const rec = sink.last()
    expect(rec.a.error.pg_code).toBe('22P02')
    expect(rec.b.error.pg_code).toBe('22P02')
    expect(rec.looped.self).toBe('[Circular]')
  })

  it("cuts a failed query's message logged as a string field", () => {
    const sink = capture()
    sink.log.warn({ error: failedQuery().message, email_masked: 'a***@acme.example' }, 'failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last().error).toBe(WITHHELD_QUERY_TEXT)
  })

  it('applies to child loggers', () => {
    const sink = capture()
    sink.log.child({ component: 'admin' }).error({ err: failedQuery() }, 'failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last()).toMatchObject({ component: 'admin', err: { pg_code: '22P02' } })
  })
})

describe('errors unrelated to a database keep the standard shape', () => {
  it('writes message, stack, type and properties as pino does', () => {
    const sink = capture()
    const error = Object.assign(new Error('outer', { cause: new Error('inner') }), {
      code: 'E_OUTER',
    })
    sink.log.error({ err: error }, 'failed')

    const { err, msg } = sink.last()
    expect(msg).toBe('failed')
    expect(err).toMatchObject({ type: 'Error', message: 'outer: inner', code: 'E_OUTER' })
    expect(err.stack).toContain('caused by:')
  })

  it("derives the message from a plain error's own message", () => {
    const sink = capture()
    sink.log.error(new Error('boom'))

    expect(sink.last()).toMatchObject({ msg: 'boom', err: { message: 'boom', type: 'Error' } })
  })

  it('now serializes an error under another key instead of printing {}', () => {
    const sink = capture()
    sink.log.warn({ error: new Error('boom') }, 'failed')

    expect(sink.last().error).toMatchObject({ type: 'Error', message: 'boom' })
  })

  it('leaves ordinary fields untouched', () => {
    const sink = capture()
    const fields = { post_id: 'post_1', tags: ['a', 'b'], meta: { count: 2 } }
    sink.log.info(fields, 'ok')

    expect(sink.last()).toMatchObject(fields)
  })

  it('drops bound values an error of another shape carries (redact backstop)', () => {
    const sink = capture()
    const error = Object.assign(new Error('custom failure'), { params: [SECRET_PARAM] })
    sink.log.error({ err: error }, 'failed')

    expect(sink.lines[0]).not.toContain(SECRET_PARAM)
    expect(sink.last().err.params).toBeUndefined()
  })
})

/**
 * The four residuals an independent verifier found on main f96d1b992 (DEF-63,
 * venturi-systems/landing-page#2309). Each case failed on that code.
 */
describe('an undefined message followed by format arguments (DEF-63 residual 1)', () => {
  it('logs a fixed message whatever follows the undefined message', () => {
    // pino formats an undefined message to undefined even when format
    // arguments follow it, then falls back to the error's own message.
    const message: string | undefined = undefined
    const sink = capture()
    sink.log.error(failedQuery(), message, 'post_1')
    sink.log.error({ err: failedQuery() }, message, 'post_1', 2)

    for (const line of sink.lines) expectNoSecrets(line)
    expect(sink.lines.map((l) => JSON.parse(l).msg)).toEqual([
      DATABASE_ERROR_LOG_MESSAGE,
      DATABASE_ERROR_LOG_MESSAGE,
    ])
  })
})

describe('bindings (DEF-63 residual 2)', () => {
  it('serializes an error bound to a child logger under any key', () => {
    const sink = capture()
    sink.log.child({ error: failedQuery() }).info('bound')
    sink.log.child({ component: 'admin' }).child({ reason: failedQuery() }).info('bound')

    for (const line of sink.lines) expectNoSecrets(line)
    const [first, second] = sink.lines.map((l) => JSON.parse(l))
    expect(first.error).toMatchObject({
      type: 'DrizzleQueryError',
      pg_code: '22P02',
      statement: STATEMENT,
    })
    expect(second).toMatchObject({ component: 'admin', reason: { pg_code: '22P02' } })
  })

  it("cuts a failed query's text out of a bound string, and out of setBindings", () => {
    const sink = capture()
    sink.log.child({ detail: failedQuery().message }).info('bound')
    const child = sink.log.child({ component: 'admin' })
    child.setBindings({ cause: failedQuery() })
    child.info('bound')

    for (const line of sink.lines) expectNoSecrets(line)
    const [first, second] = sink.lines.map((l) => JSON.parse(l))
    expect(first.detail).toBe(WITHHELD_QUERY_TEXT)
    expect(second).toMatchObject({ component: 'admin', cause: { pg_code: '22P02' } })
  })

  it("serializes an error in the logger's own base bindings", () => {
    const lines: string[] = []
    const log = createLogger({
      level: 'trace',
      base: { boot_error: failedQuery() },
      destination: { write: (s: string) => lines.push(s) },
    })
    log.info('started')

    expectNoSecrets(lines[0])
    expect(JSON.parse(lines[0]).boot_error).toMatchObject({ pg_code: '22P02' })
  })
})

describe("a failed query's text that no database error carries (DEF-63 residual 3)", () => {
  /** A class instance, which `JSON.stringify` writes as its own properties. */
  class QueryContext {
    constructor(
      public readonly sql: string,
      public readonly source?: Error
    ) {}
  }

  it('withholds it in a string property and a string cause of an ordinary error', () => {
    const withProperty = Object.assign(new Error('lookup failed'), {
      detail: failedQuery().message,
    })
    const withCause = new Error('lookup failed')
    ;(withCause as { cause?: unknown }).cause = failedQuery().message
    const sink = capture()
    sink.log.error({ err: withProperty }, 'failed')
    sink.log.error({ err: withCause }, 'failed')

    for (const line of sink.lines) expectNoSecrets(line)
    const [first, second] = sink.lines.map((l) => JSON.parse(l).err)
    expect(first).toMatchObject({ message: 'lookup failed', detail: WITHHELD_QUERY_TEXT })
    expect(second).toMatchObject({ message: 'lookup failed', cause: WITHHELD_QUERY_TEXT })
  })

  it('withholds it in an error-like plain object', () => {
    const error = Object.assign(new Error('lookup failed'), {
      inner: { message: failedQuery().message, code: 'E_LOOKUP' },
    })
    const sink = capture()
    sink.log.error({ err: error }, 'failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last().err.inner).toEqual({ message: WITHHELD_QUERY_TEXT, code: 'E_LOOKUP' })
  })

  it('withholds it, and a failed query, in a class instance an error holds', () => {
    const withText = Object.assign(new Error('lookup failed'), {
      context: new QueryContext(failedQuery().message),
    })
    const withQuery = Object.assign(new Error('lookup failed'), {
      context: new QueryContext('select 1', failedQuery()),
    })
    const sink = capture()
    sink.log.error({ err: withText }, 'failed')
    sink.log.error({ err: withQuery }, 'failed')

    for (const line of sink.lines) expectNoSecrets(line)
    const [first, second] = sink.lines.map((l) => JSON.parse(l).err)
    expect(first.context).toEqual({ sql: WITHHELD_QUERY_TEXT })
    expect(second.context).toMatchObject({ sql: 'select 1', source: { pg_code: '22P02' } })
  })

  it('withholds a failed query in a class instance logged as a field or a format argument', () => {
    const sink = capture()
    sink.log.warn({ context: new QueryContext('select 1', failedQuery()) }, 'failed')
    sink.log.warn('failed: %o', new QueryContext(failedQuery().message))

    for (const line of sink.lines) expectNoSecrets(line)
    const [first, second] = sink.lines.map((l) => JSON.parse(l))
    expect(first.context).toMatchObject({ sql: 'select 1', source: { pg_code: '22P02' } })
    expect(second.msg).toBe(`failed: {"sql":"${WITHHELD_QUERY_TEXT}"}`)
  })

  it('keeps an ordinary class instance as JSON.stringify writes it', () => {
    const sink = capture()
    const at = new Date('2026-09-25T00:00:00.000Z')
    sink.log.info({ context: new QueryContext('select 1'), at }, 'ok')

    expect(sink.last()).toMatchObject({
      context: { sql: 'select 1' },
      at: '2026-09-25T00:00:00.000Z',
    })
  })

  it('cuts it out of the finished line when a toJSON result carries it (the last layer)', () => {
    class Snapshot {
      toJSON() {
        return { sql: failedQuery().message, rows: 0 }
      }
    }
    const sink = capture()
    sink.log.info({ snapshot: new Snapshot() }, 'state')

    expectNoSecrets(sink.lines[0])
    expect(sink.last().snapshot).toEqual({ sql: WITHHELD_QUERY_TEXT, rows: 0 })
  })
})

describe('stacks that carry a failed query (DEF-63 residual 4)', () => {
  // drizzle-orm joins bound values with commas, so a bound value can hold
  // text shaped like a stack frame.
  const FRAME_SHAPED_VALUE = `x\n    at leak (file:///${SECRET_PARAM}.js:1:1)`

  function frameShapedQuery(): DrizzleQueryError {
    return new DrizzleQueryError(STATEMENT, [FRAME_SHAPED_VALUE], postgresError())
  }

  it("keeps only the error's own frames after a failed query no database error carries", () => {
    // The app built its message from the failed query's and dropped the error.
    const error = new AppError(`Failed to list posts: ${frameShapedQuery().message}`)
    const sink = capture()
    sink.log.error({ err: error }, 'list failed')

    expectNoSecrets(sink.lines[0])
    const lines = (sink.last().err.stack as string).split('\n')
    expect(lines[0]).toBe(`AppError: Failed to list posts: ${WITHHELD_QUERY_TEXT}`)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines.slice(1)) expect(line).toMatch(/^\s+at\s/)
  })

  it('keeps nothing after a failed query in a stack the error does not own', () => {
    const error = new AppError('lookup failed')
    error.stack = [
      'AppError: lookup failed (retried)',
      '    at first (file:///app.js:1:1)',
      frameShapedQuery().message,
      '    at second (file:///app.js:2:2)',
    ].join('\n')
    const sink = capture()
    sink.log.error({ err: error }, 'lookup failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last().err.stack).toBe(
      [
        'AppError: lookup failed (retried)',
        '    at first (file:///app.js:1:1)',
        WITHHELD_QUERY_TEXT,
      ].join('\n')
    )
  })
})

describe('an Error pino cannot read (verifier finding on main c262d3ea4)', () => {
  /** An Error whose message is no longer a string. */
  function messageless(): Error {
    return Object.assign(new Error('lookup failed'), { message: undefined })
  }

  /** An Error whose message getter throws. */
  function unreadable(): Error {
    return Object.defineProperty(new Error('lookup failed'), 'message', {
      get() {
        throw new Error('message getter failed')
      },
    })
  }

  it('writes one line, and does not recurse, for an Error with a non-string message', () => {
    const sink = capture()
    sink.log.error({ err: messageless() }, 'as err')
    sink.log.error({ other: messageless() }, 'under another key')
    sink.log.error(messageless())
    sink.log.error({ step: 1 }, 'as a format argument %o', messageless())

    expect(sink.lines).toHaveLength(4)
    const [asErr, other, alone] = sink.lines.map((line) => JSON.parse(line))
    expect(asErr.err).toEqual({ type: 'Error', message: '[unserializable]' })
    expect(other.other).toEqual({ type: 'Error', message: '[unserializable]' })
    expect(alone.err).toEqual({ type: 'Error', message: '[unserializable]' })
    expect(alone.msg).toBe('[unserializable]')
  })

  it('writes one line for an Error whose message getter throws, with no message of its own', () => {
    const sink = capture()
    sink.log.error({ err: unreadable() })
    sink.log.error(unreadable())
    sink.log.warn({ nested: { error: unreadable() } }, 'nested')

    expect(sink.lines).toHaveLength(3)
    const [asErr, alone, nested] = sink.lines.map((line) => JSON.parse(line))
    expect(asErr).toMatchObject({
      msg: '[unserializable]',
      err: { type: 'Error', message: '[unserializable]' },
    })
    expect(alone).toMatchObject({
      msg: '[unserializable]',
      err: { type: 'Error', message: '[unserializable]' },
    })
    expect(nested.nested.error).toEqual({ type: 'Error', message: '[unserializable]' })
  })
})

describe('a failed query nested past the inspected depth (verifier finding on main c262d3ea4)', () => {
  /** `value` wrapped in `levels` plain objects. */
  function nest(value: unknown, levels: number): Record<string, unknown> {
    let out: Record<string, unknown> = { value }
    for (let level = 1; level < levels; level++) out = { next: out }
    return out
  }

  it('withholds a failed query 70 plain-object levels deep', () => {
    const sink = capture()
    sink.log.info({ deep: nest(failedQuery(), 70) }, 'deep')

    expectNoSecrets(sink.lines[0])
    expect(sink.lines[0]).toContain('[truncated]')
  })

  it('withholds its text in a string 70 plain-object levels deep', () => {
    const sink = capture()
    sink.log.info({ deep: nest({ sql: failedQuery().message }, 70) }, 'deep')

    expectNoSecrets(sink.lines[0])
  })

  it('keeps an ordinary value nested as deep', () => {
    const sink = capture()
    sink.log.info({ deep: nest({ rows: 3, table: 'posts' }, 70) }, 'deep')

    let level = sink.last().deep
    for (let depth = 1; depth < 70; depth++) level = level.next
    expect(level.value).toEqual({ rows: 3, table: 'posts' })
  })
})
