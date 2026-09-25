import { describe, expect, it } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import { ConflictError, InternalError, ValidationError } from '@/lib/shared/errors'
import { isDatabaseError, isUniqueViolation, postgresErrorCode } from '../database-error'

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
