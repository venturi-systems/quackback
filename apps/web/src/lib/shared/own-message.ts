/**
 * Look up a display message by a key that came from outside the program,
 * such as a `?error=` query parameter.
 *
 * Indexing a plain object with such a key is unsafe: `__proto__`,
 * `constructor` or `toString` resolve to inherited Object.prototype members,
 * not to a message. Rendering that value throws ("Objects are not valid as a
 * React child") or prints function source. Only an own property that holds a
 * string counts as a match; everything else returns null.
 */
export function ownMessage(
  table: Readonly<Record<string, string>>,
  key: string | null | undefined
): string | null {
  if (typeof key !== 'string' || !Object.hasOwn(table, key)) return null
  const value = table[key]
  return typeof value === 'string' ? value : null
}
