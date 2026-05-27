import { describe, it, expect } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { boards } from '../boards'

describe('boards.access column', () => {
  it('exists alongside boards.audience (transitional)', () => {
    const cols = getTableColumns(boards)
    expect(cols.access).toBeDefined()
    expect(cols.audience).toBeDefined() // still present until 0080
  })

  it('access is NOT NULL with a default', () => {
    const cols = getTableColumns(boards)
    const col = cols.access as unknown as { notNull: boolean; default: unknown }
    expect(col.notNull).toBe(true)
    expect(col.default).toBeDefined()
  })
})
