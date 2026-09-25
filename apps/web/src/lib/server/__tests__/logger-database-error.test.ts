/**
 * DEF-63 with the real error classes: the web app's logger (the shared
 * @quackback/logger createLogger) never writes a failed query's bound values,
 * its message, or the Postgres error's message and detail.
 *
 * Each case logs through the real `createLogger` into a capture stream and
 * inspects the emitted JSON line, for a bare drizzle-orm DrizzleQueryError, an
 * app error wrapping one (as the REST catch-all and the server functions log
 * them), and a postgres.js PostgresError.
 */
import { describe, expect, it } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import postgres from 'postgres'
import { DATABASE_ERROR_LOG_MESSAGE, WITHHELD_QUERY_TEXT } from '@quackback/logger'
import { InternalError } from '@/lib/shared/errors'
import { createLogger } from '../logger'

const SECRET_PARAM = 'tok_live_SECRET_7331'
const SECRET_EMAIL = 'ann@acme.example'
const SEARCH_TEXT = 'my private search words'
const PG_MESSAGE = `invalid input syntax for type uuid: "${SECRET_PARAM}"`
const PG_DETAIL = `Key (email)=(${SECRET_EMAIL}) already exists.`
const STATEMENT =
  'select "id" from "user" where "name" ilike $1 and "email" = $2 and "api_key" = $3'

/** Texts that must never appear anywhere in an emitted line. */
const SECRETS = [
  SECRET_PARAM,
  SECRET_EMAIL,
  SEARCH_TEXT,
  PG_MESSAGE,
  PG_DETAIL,
  'already exists',
  'Failed query',
  'params:',
]

/**
 * A postgres.js PostgresError as its connection builds one: the server's
 * fields copied on, then the query and its values attached by queryError(),
 * enumerable only when the client's `debug` option is on.
 */
function postgresError(debug = false): Error {
  const PostgresError = postgres.PostgresError as unknown as new (
    fields: Record<string, string>
  ) => Error
  const error = new PostgresError({
    message: PG_MESSAGE,
    severity_local: 'ERROR',
    severity: 'ERROR',
    code: '22P02',
    detail: PG_DETAIL,
    routine: 'string_to_uuid',
    table_name: 'user',
    column_name: 'id',
  })
  Object.defineProperties(error, {
    query: { value: STATEMENT, enumerable: debug },
    parameters: { value: [SEARCH_TEXT, SECRET_EMAIL, SECRET_PARAM], enumerable: debug },
    args: { value: [SEARCH_TEXT, SECRET_EMAIL, SECRET_PARAM], enumerable: debug },
  })
  return error
}

function failedQuery(): DrizzleQueryError {
  return new DrizzleQueryError(
    STATEMENT,
    [SEARCH_TEXT, SECRET_EMAIL, SECRET_PARAM],
    postgresError()
  )
}

function capture() {
  const lines: string[] = []
  const log = createLogger({ level: 'trace', destination: { write: (s: string) => lines.push(s) } })
  return { log, lines, last: () => JSON.parse(lines[lines.length - 1]) }
}

function expectNoSecrets(line: string | undefined) {
  expect(line).toBeDefined()
  for (const secret of SECRETS) expect(line).not.toContain(secret)
}

describe('logger and database errors (DEF-63)', () => {
  it('writes a bare DrizzleQueryError as its safe fields only', () => {
    const sink = capture()
    sink.log.error({ err: failedQuery() }, 'admin user search failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last()).toMatchObject({
      msg: 'admin user search failed',
      err: {
        type: 'DrizzleQueryError',
        message: DATABASE_ERROR_LOG_MESSAGE,
        pg_code: '22P02',
        statement: STATEMENT,
        param_count: 3,
        table: 'user',
      },
    })
  })

  it('writes an app error that wraps a DrizzleQueryError without the cause', () => {
    const sink = capture()
    sink.log.error(
      { err: new InternalError('DATABASE_ERROR', 'Failed to search users', failedQuery()) },
      'unexpected error'
    )

    expectNoSecrets(sink.lines[0])
    expect(sink.last().err).toMatchObject({
      type: 'InternalError',
      message: 'Failed to search users',
      code: 'DATABASE_ERROR',
      cause: { type: 'DrizzleQueryError', pg_code: '22P02' },
    })
  })

  it("withholds a DrizzleQueryError's message copied into an app error", () => {
    const failed = failedQuery()
    const sink = capture()
    sink.log.error(
      { err: new InternalError('DATABASE_ERROR', `Failed to fetch: ${failed.message}`, failed) },
      'unhandled domain error'
    )

    expectNoSecrets(sink.lines[0])
    expect(sink.last().err.message).toBe(`Failed to fetch: ${WITHHELD_QUERY_TEXT}`)
  })

  it('writes a postgres.js PostgresError as its safe fields only, even in debug mode', () => {
    for (const debug of [false, true]) {
      const sink = capture()
      sink.log.error({ err: postgresError(debug) }, 'query failed')

      expectNoSecrets(sink.lines[0])
      expect(sink.last().err).toMatchObject({
        type: 'PostgresError',
        pg_code: '22P02',
        statement: STATEMENT,
        param_count: 3,
      })
    }
  })

  it('never lets pino derive the message from a failed query', () => {
    const sink = capture()
    sink.log.error(failedQuery())
    sink.log.warn({ err: failedQuery() })

    for (const line of sink.lines) expectNoSecrets(line)
    expect(sink.lines.map((l) => JSON.parse(l).msg)).toEqual([
      DATABASE_ERROR_LOG_MESSAGE,
      DATABASE_ERROR_LOG_MESSAGE,
    ])
  })

  it('treats errors logged under other keys the same way', () => {
    const sink = capture()
    sink.log.error({ error: failedQuery(), detail: { cause: postgresError(true) } }, 'failed')

    expectNoSecrets(sink.lines[0])
    expect(sink.last()).toMatchObject({
      error: { type: 'DrizzleQueryError', pg_code: '22P02' },
      detail: { cause: { type: 'PostgresError', pg_code: '22P02' } },
    })
  })
})
