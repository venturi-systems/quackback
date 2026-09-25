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
