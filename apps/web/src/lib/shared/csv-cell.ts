/**
 * One CSV cell, safe to open in a spreadsheet.
 *
 * A cell whose text starts with `=`, `+`, `-`, `@`, a tab or a carriage return
 * is prefixed with a single quote, so Excel, Numbers and Sheets read it as
 * text instead of evaluating it as a formula (CSV formula injection). Every
 * non-empty cell is quoted and embedded quotes are doubled. Null and undefined
 * become an empty cell; objects are serialised as JSON.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

/** One CSV line from a list of cell values. */
export function csvLine(values: readonly unknown[]): string {
  return values.map(csvCell).join(',')
}
