import { describe, expect, it } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import { ConflictError, InternalError, ValidationError } from '@/lib/shared/errors'
import {
  databaseErrorLogFields,
  isDatabaseError,
  isUniqueViolation,
  postgresErrorCode,
} from '../database-error'

// drizzle-orm 0.45 wraps every failed query in a DrizzleQueryError whose
// `cause` is the Postgres error. These helpers read the SQLSTATE through that
// wrapper and tell a failed query from an app error.

/** A Postgres error as postgres.js throws it: a SQLSTATE code and a severity. */
function postgresError(code: string, message = 'duplicate key value violates unique constraint') {
  return Object.assign(new Error(message), { code, severity: 'ERROR', routine: '_bt_check_unique' })
}

function failedQuery(cause: unknown) {
  return new DrizzleQueryError(
    'insert into "users" ("email") values ($1)',
    ['ann@acme.example'],
    cause as Error
  )
}

describe('postgresErrorCode', () => {
  it('reads the SQLSTATE through the drizzle wrapper', () => {
    expect(postgresErrorCode(failedQuery(postgresError('23505')))).toBe('23505')
  })

  it('reads the code of a bare Postgres error or error-shaped object', () => {
    expect(postgresErrorCode(postgresError('22P02'))).toBe('22P02')
    expect(postgresErrorCode({ code: '23505' })).toBe('23505')
  })

  it('follows an app error that wraps a failed query', () => {
    const wrapped = new InternalError(
      'DATABASE_ERROR',
      'Failed',
      failedQuery(postgresError('23503'))
    )
    expect(postgresErrorCode(wrapped)).toBe('23503')
  })

  it('ignores app error codes, which are not SQLSTATEs', () => {
    expect(postgresErrorCode(new ValidationError('VALIDATION_ERROR', 'bad'))).toBeUndefined()
    expect(postgresErrorCode(new Error('plain'))).toBeUndefined()
    expect(postgresErrorCode(undefined)).toBeUndefined()
    expect(postgresErrorCode('23505')).toBeUndefined()
  })

  it('stops on a cause chain that loops', () => {
    const a: { cause?: unknown } = {}
    const b = { cause: a }
    a.cause = b
    expect(postgresErrorCode(a)).toBeUndefined()
  })
})

describe('isUniqueViolation', () => {
  it('matches 23505 however it is wrapped', () => {
    expect(isUniqueViolation(postgresError('23505'))).toBe(true)
    expect(isUniqueViolation(failedQuery(postgresError('23505')))).toBe(true)
  })

  it('does not match other failures', () => {
    expect(isUniqueViolation(failedQuery(postgresError('23503')))).toBe(false)
    expect(isUniqueViolation(new ConflictError('DUPLICATE_KEY', 'exists'))).toBe(false)
  })
})

describe('isDatabaseError', () => {
  it('recognises a failed query and a driver error', () => {
    expect(isDatabaseError(failedQuery(postgresError('22P02')))).toBe(true)
    expect(isDatabaseError(postgresError('23505'))).toBe(true)
    const named = new Error('connection terminated')
    named.name = 'PostgresError'
    expect(isDatabaseError(named)).toBe(true)
  })

  it('leaves app errors alone, even when they wrap a failed query', () => {
    expect(
      isDatabaseError(
        new InternalError('DATABASE_ERROR', 'Failed', failedQuery(postgresError('23505')))
      )
    ).toBe(false)
    expect(isDatabaseError(new ValidationError('VALIDATION_ERROR', 'bad'))).toBe(false)
    expect(isDatabaseError(new Error('Authentication required'))).toBe(false)
  })

  it('reads only errors', () => {
    expect(isDatabaseError({ query: 'select 1', params: [] })).toBe(false)
    expect(isDatabaseError('Failed query: select 1')).toBe(false)
    expect(isDatabaseError(null)).toBe(false)
  })
})

describe('databaseErrorLogFields (DEF-63)', () => {
  // A failed query whose bound value, Postgres message and detail all carry
  // user data, as they do in production (an email address, a pasted token).
  function leakyFailedQuery() {
    const message = 'invalid input syntax for type uuid: "tok_live_SECRET"'
    const cause = Object.assign(new Error(message), {
      code: '23505',
      severity: 'ERROR',
      routine: '_bt_check_unique',
      table_name: 'users',
      constraint_name: 'users_email_key',
      detail: 'Key (email)=(ann@acme.example) already exists.',
    })
    return new DrizzleQueryError(
      'insert into "users" ("email", "token") values ($1, $2)',
      ['ann@acme.example', 'tok_live_SECRET'],
      cause
    )
  }

  it('keeps the statement, codes and identifiers', () => {
    expect(databaseErrorLogFields(leakyFailedQuery())).toEqual({
      pg_code: '23505',
      error_name: 'DrizzleQueryError',
      statement: 'insert into "users" ("email", "token") values ($1, $2)',
      param_count: 2,
      severity: 'ERROR',
      routine: '_bt_check_unique',
      table: 'users',
      constraint: 'users_email_key',
    })
  })

  it('never returns a parameter value, the message or the Postgres detail', () => {
    const logged = JSON.stringify(databaseErrorLogFields(leakyFailedQuery()))
    const secrets = ['ann@acme.example', 'tok_live_SECRET', 'already exists', 'Failed query']
    for (const secret of secrets) {
      expect(logged).not.toContain(secret)
    }
  })

  it('classifies a bare Postgres error by shape and ignores non-errors', () => {
    const error = postgresError('22P02', 'bad input "x"')
    // DEF-63 uses the driver's shape, not a constructor name that a bundler
    // can rename. This native Error still represents a Postgres driver error.
    expect(error.name).toBe('Error')
    expect(databaseErrorLogFields(error)).toEqual({
      pg_code: '22P02',
      error_name: 'PostgresError',
      severity: 'ERROR',
      routine: '_bt_check_unique',
    })
    expect(databaseErrorLogFields(undefined)).toEqual({})
  })
})
