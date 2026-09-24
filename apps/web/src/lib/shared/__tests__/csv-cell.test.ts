import { describe, it, expect } from 'vitest'
import { csvCell, csvLine } from '../csv-cell'

describe('csvCell', () => {
  it.each(['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'neutralises a leading formula character in %j',
    (value) => {
      expect(csvCell(value).startsWith(`"'`)).toBe(true)
    }
  )

  it('quotes cells and doubles embedded quotes', () => {
    expect(csvCell('a "b", c\nd')).toBe('"a ""b"", c\nd"')
  })

  it('writes null and undefined as an empty cell', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('serialises objects as JSON (before and after values)', () => {
    expect(csvCell({ role: 'admin' })).toBe('"{""role"":""admin""}"')
  })

  it('joins a line', () => {
    expect(csvLine(['a', null, 1])).toBe('"a",,"1"')
  })
})
