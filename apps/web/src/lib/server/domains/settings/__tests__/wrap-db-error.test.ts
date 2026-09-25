/**
 * DEF-63: `wrapDbError` builds a message that can reach a server function's
 * caller and the log, so a failed query's own message (its SQL and every
 * bound value) is never copied into it.
 */
import { describe, expect, it } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import { InternalError, NotFoundError } from '@/lib/shared/errors'
import { wrapDbError } from '../settings.helpers'

function thrownBy(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

describe('wrapDbError (DEF-63)', () => {
  it('names the operation only when the error is a failed query', () => {
    const failed = new DrizzleQueryError(
      'select * from "identity_provider" where "client_secret" = $1',
      ['tok_live_SECRET_9001'],
      new Error('boom')
    )
    const thrown = thrownBy(() => wrapDbError('list identity providers', failed))

    expect(thrown).toBeInstanceOf(InternalError)
    expect((thrown as InternalError).message).toBe('Failed to list identity providers')
    expect((thrown as InternalError).message).not.toContain('tok_live_SECRET_9001')
    expect((thrown as InternalError).cause).toBe(failed)
  })

  it('names the operation only when an app error already carries a failed query', () => {
    const failed = new DrizzleQueryError('select 1 where $1', ['tok_live_SECRET_9001'])
    const wrapped = new InternalError('DATABASE_ERROR', `lookup: ${failed.message}`, failed)
    const thrown = thrownBy(() => wrapDbError('load settings', wrapped))

    expect((thrown as InternalError).message).toBe('Failed to load settings')
  })

  it('keeps the message of any other error', () => {
    const thrown = thrownBy(() => wrapDbError('load settings', new Error('cache offline')))

    expect((thrown as InternalError).message).toBe('Failed to load settings: cache offline')
  })

  it('rethrows a not-found error unchanged', () => {
    const missing = new NotFoundError('SETTINGS_NOT_FOUND', 'Settings not found')

    expect(thrownBy(() => wrapDbError('load settings', missing))).toBe(missing)
  })
})
