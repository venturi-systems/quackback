import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm'
import { ConflictError, InternalError } from '@/lib/shared/errors'

// drizzle-orm 0.45 throws a DrizzleQueryError for a failed insert, with the
// Postgres error as its `cause`. createUserAttribute must still recognise a
// duplicate key (SQLSTATE 23505) through that wrapper and answer it as a
// conflict, not as an internal database error.

const hoisted = vi.hoisted(() => ({ insertError: null as unknown }))

vi.mock('@/lib/server/db', () => ({
  db: {
    insert: () => ({
      values: () => ({
        returning: () => Promise.reject(hoisted.insertError),
      }),
    }),
  },
  eq: vi.fn(),
  asc: vi.fn(),
  userAttributeDefinitions: {},
}))

import { createUserAttribute } from '../user-attribute.service'

function failedInsert(code: string) {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    severity: 'ERROR',
  })
  return new DrizzleQueryError('insert into "user_attribute_definitions" ...', ['plan'], cause)
}

const INPUT = { key: 'plan', label: 'Plan', type: 'string' as const }

beforeEach(() => {
  hoisted.insertError = null
})

describe('createUserAttribute', () => {
  it('answers a duplicate key behind the drizzle wrapper as a conflict', async () => {
    hoisted.insertError = failedInsert('23505')
    const error = await createUserAttribute(INPUT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).code).toBe('DUPLICATE_KEY')
  })

  it('still answers any other database failure as an internal error', async () => {
    hoisted.insertError = failedInsert('23503')
    const error = await createUserAttribute(INPUT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InternalError)
  })
})
