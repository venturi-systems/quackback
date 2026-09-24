/**
 * `value` as a literal inside a LIKE or ILIKE pattern: the pattern characters
 * `%` and `_` and the escape character `\` are escaped, so each matches
 * itself.
 *
 * Postgres rejects a pattern that ends in the escape character, so a search
 * value ending in a backslash (`?emailDomain=example.com%5C`, `?q=a%5C`) used
 * to fail the whole query (DEF-45). Wrap the escaped value with your own `%`
 * wildcards: `%${likeText(search)}%`.
 */
export function likeText(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}
