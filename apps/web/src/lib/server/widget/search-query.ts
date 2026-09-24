/**
 * Query values for the public widget search endpoints, `/api/widget/search`
 * and `/api/widget/kb-search`.
 *
 * These endpoints read the query string themselves, so the route search-param
 * helpers in `lib/shared/search-params.ts` never see their values. A value
 * from a hand-typed or shared URL must still never fail the query it feeds:
 *
 * - Postgres rejects a NUL character in any text. A search term or board slug
 *   holding one (a decoded `%00`) failed the full-text search or the slug
 *   compare, and the endpoint answered 500. No stored text can hold a NUL, so
 *   such a filter matches nothing: `isMatchableText` says so, and the endpoint
 *   answers with an empty result.
 * - The row limit reaches `LIMIT`, which rejects a negative or fractional
 *   value. `searchLimit` keeps only a whole number from 1 up, capped at the
 *   endpoint's maximum, and reads anything else as absent.
 */

/** Whether `value` can match stored text. Postgres text never holds a NUL. */
export function isMatchableText(value: string): boolean {
  return !value.includes('\u0000')
}

/**
 * The row limit for a `?limit=` value: a whole number from 1 up, capped at
 * `max`. An absent, empty, zero, negative, fractional or non-numeric value
 * reads as absent and gives `fallback`.
 */
export function searchLimit(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback
}
