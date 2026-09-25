/**
 * Tests for the server-function database-error redaction (DEF-45).
 *
 * TanStack Start sends a server function's error message to the caller. For a
 * failed query that message is drizzle's `Failed query: <sql>\nparams: ...`,
 * so the middleware replaces a database error with a fixed message and lets
 * every other error through unchanged.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import { InternalError, NotFoundError } from '@/lib/shared/errors'
import {
  DATABASE_ERROR_MESSAGE,
  redactDatabaseError,
  serverFnDatabaseErrorRedaction,
  withDatabaseErrorRedaction,
} from '../serverfn-database-error'

const SQL = 'select "email" from "user" where "id" = $1'
const PARAMS = ['user_secret_param']

function failedQuery() {
  const cause = Object.assign(new Error('invalid input syntax for type uuid: "x"'), {
    code: '22P02',
    severity: 'ERROR',
  })
  return new DrizzleQueryError(SQL, PARAMS, cause)
}

describe('redactDatabaseError', () => {
  it('replaces a failed query with a fixed message that carries no SQL', () => {
    const original = failedQuery()
    expect(original.message).toContain(SQL)
    const redacted = redactDatabaseError(original) as Error
    expect(redacted).not.toBe(original)
    expect(redacted).toBeInstanceOf(Error)
    expect(redacted.message).toBe(DATABASE_ERROR_MESSAGE)
    expect(JSON.stringify({ message: redacted.message })).not.toContain('user_secret_param')
  })

  it('returns every other error unchanged', () => {
    const notFound = new NotFoundError('POST_NOT_FOUND', 'Post not found')
    const wrapped = new InternalError('DATABASE_ERROR', 'Failed to save', failedQuery())
    const plain = new Error('Authentication required')
    for (const error of [notFound, wrapped, plain, 'text', undefined]) {
      expect(redactDatabaseError(error)).toBe(error)
    }
  })
})

describe('withDatabaseErrorRedaction', () => {
  it('passes a result through', async () => {
    await expect(withDatabaseErrorRedaction(async () => 'ok')).resolves.toBe('ok')
  })

  it('rethrows an app error as the same object', async () => {
    const notFound = new NotFoundError('POST_NOT_FOUND', 'Post not found')
    await expect(
      withDatabaseErrorRedaction(async () => {
        throw notFound
      })
    ).rejects.toBe(notFound)
  })

  it('throws the fixed message for a failed query', async () => {
    await expect(
      withDatabaseErrorRedaction(async () => {
        throw failedQuery()
      })
    ).rejects.toThrow(new Error(DATABASE_ERROR_MESSAGE))
  })
})

describe('serverFnDatabaseErrorRedaction', () => {
  type ServerFn = (ctx: { next: () => Promise<unknown> }) => Promise<unknown>
  const server = (serverFnDatabaseErrorRedaction.options as unknown as { server: ServerFn }).server

  it('redacts what the rest of the chain throws', async () => {
    await expect(
      server({
        next: async () => {
          throw failedQuery()
        },
      })
    ).rejects.toThrow(DATABASE_ERROR_MESSAGE)
    await expect(server({ next: async () => ({ result: 1 }) })).resolves.toEqual({ result: 1 })
  })

  it('is registered right after the dispatch marker, ahead of the NUL guard', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const start = readFileSync(join(here, '../../../../start.ts'), 'utf8')
    const list = start.match(/functionMiddleware:\s*\[([^\]]*)\]/)?.[1]
    expect(
      list
        ?.split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    ).toEqual(['serverFnDispatchMarker', 'serverFnDatabaseErrorRedaction', 'serverFnNulGuard'])
  })
})
