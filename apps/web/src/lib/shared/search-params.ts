import { z } from 'zod'
import { isValidTypeId, type IdPrefix } from '@quackback/ids'

/**
 * Zod pieces for route `validateSearch` schemas that never fail a request.
 *
 * TanStack Router reads every query value through `JSON.parse` first and keeps
 * the raw string only when that fails. The app's own links therefore carry
 * lists as JSON (`?board=["ideas"]`), while a URL someone types, pastes or
 * links from elsewhere carries a bare value (`?board=ideas`), and a
 * numeric-looking value arrives as a number (`?search=123` is `123`).
 *
 * When a route's `validateSearch` rejects any of that, the router raises a
 * SearchParamError: the server answers 500 and dehydrates the raw zod issue
 * list into the page ("Invalid input: expected array, received string").
 * That was DEF-45 on `/roadmap?board=<anything>`.
 *
 * Each helper accepts every shape a real URL can produce, normalizes it to the
 * type the route already consumes, and ends in `.catch()`, the fallback
 * pattern TanStack's search-param guide recommends, so anything else reads as
 * absent instead of throwing. On the server the router then redirects to the
 * canonical URL built from the validated values, so a malformed address lands
 * on a working page with a clean URL.
 *
 * Parsing is only half of it. A value can pass the schema and still break the
 * query it feeds: an id column encodes its value as a TypeID and throws on
 * anything else, a count is compared with a 32-bit integer column, and a date
 * becomes a `Date` that must be valid. So an id parameter keeps only
 * well-formed TypeIDs of its own prefix (`searchId`, `searchIdList`,
 * `searchIdCsv`), a count only whole numbers the column can hold
 * (`searchCount`), and a date only an ISO date that `Date` can read
 * (`searchDate`).
 *
 * Coercing a number or boolean back to text is exact for everything this app
 * puts in a URL: ids are prefixed TypeIDs, which never parse as JSON. Only
 * free text that happens to be a JSON number can differ from what was typed
 * (`1e3` reads as `1000`), which is still a valid search.
 */

/** The largest value a Postgres `integer` column, or a `count(*)::int`, can hold. */
export const MAX_SEARCH_COUNT = 2_147_483_647

/** One query value as TanStack's JSON-first parser can deliver it. */
const queryValue = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value))

/**
 * An optional text parameter. A number or boolean reads as its text; any other
 * shape (a list, an object) reads as absent.
 */
export function searchText() {
  return queryValue.optional().catch(undefined)
}

/**
 * An optional text parameter kept only when `accept` returns true for it; any
 * other value, like any other shape, reads as absent.
 */
export function searchWhere(accept: (value: string) => boolean) {
  return queryValue.refine(accept).optional().catch(undefined)
}

/**
 * An optional choice among fixed values; any other value reads as absent. The
 * value is matched as text, so `?verified=true`, which the parser delivers as
 * the boolean `true`, still selects the choice `'true'`.
 */
export function searchChoice<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .preprocess(
      (value) => (typeof value === 'number' || typeof value === 'boolean' ? String(value) : value),
      z.enum(values)
    )
    .optional()
    .catch(undefined)
}

/**
 * An optional list parameter. Accepts the app's JSON list form and a single
 * bare value (`?board=ideas` reads as `['ideas']`). A bare empty value reads
 * as absent, and so does any other shape (an object, a nested list).
 *
 * Use it for free-text or slug lists only. An id list goes through
 * `searchIdList`, because the database rejects an id that is not a TypeID.
 */
export function searchList() {
  return z
    .union([
      z.array(queryValue),
      queryValue.transform((value) => (value === '' ? undefined : [value])),
    ])
    .optional()
    .catch(undefined)
}

/** Whether `value` is a TypeID with this prefix, the only id form the app writes. */
function isIdOf(prefix: IdPrefix) {
  return (value: string) => isValidTypeId(value, prefix)
}

/**
 * An optional id parameter: a TypeID with this prefix. Anything else (a slug,
 * a number, another entity's id) reads as absent, so it never reaches a query
 * whose id column would throw on it.
 */
export function searchId(prefix: IdPrefix) {
  return searchWhere(isIdOf(prefix))
}

/**
 * An optional id list parameter, in any shape `searchList` accepts. Only the
 * TypeIDs with this prefix are kept; the list reads as absent when none is.
 */
export function searchIdList(prefix: IdPrefix) {
  const isId = isIdOf(prefix)
  return z
    .union([z.array(queryValue), queryValue.transform((value) => [value])])
    .transform((items) => {
      const ids = items.filter(isId)
      return ids.length > 0 ? ids : undefined
    })
    .optional()
    .catch(undefined)
}

/**
 * An optional comma-separated id list (`?segments=a,b`), kept as text in that
 * form. Only the TypeIDs with this prefix are kept; the value reads as absent
 * when none is.
 */
export function searchIdCsv(prefix: IdPrefix) {
  const isId = isIdOf(prefix)
  return queryValue
    .transform((value) => {
      const ids = value.split(',').filter(isId)
      return ids.length > 0 ? ids.join(',') : undefined
    })
    .optional()
    .catch(undefined)
}

/** Whether `value` is a whole number that a 32-bit integer column can hold. */
export function isSearchCount(value: string): boolean {
  return /^\d{1,10}$/.test(value) && Number(value) <= MAX_SEARCH_COUNT
}

/**
 * An optional count threshold, kept as its text (`?minVotes=5`). Anything that
 * is not a whole number in integer range reads as absent.
 */
export function searchCount() {
  return searchWhere(isSearchCount)
}

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/

/**
 * An optional date, kept as its text: an ISO date (`2026-01-31`) or an ISO
 * timestamp. Anything else, or a value `Date` cannot turn into a time
 * (`2026-13-45`), reads as absent.
 */
export function searchDate() {
  return searchWhere((value) => ISO_DATE.test(value) && !Number.isNaN(new Date(value).getTime()))
}
