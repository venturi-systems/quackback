import { describe, it, expect, expectTypeOf } from 'vitest'
import { settings } from '../schema/auth'

describe('settings.state column', () => {
  it('stores a required text state with an active default', () => {
    const column = settings.state
    expect(column.dataType).toBe('string')
    expect(column.getSQLType()).toBe('text')
    expect(column.notNull).toBe(true)
    expect(column.default).toBe('active')
  })

  it('restricts selected state values to the lifecycle union', () => {
    expectTypeOf<(typeof settings.$inferSelect)['state']>().toEqualTypeOf<
      'active' | 'suspended' | 'deleting'
    >()
  })
})
