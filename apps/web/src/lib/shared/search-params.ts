import { z } from 'zod'

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
 * Coercing a number or boolean back to text is exact for everything this app
 * puts in a URL: ids are prefixed TypeIDs or UUIDs, which never parse as JSON.
 * Only free text that happens to be a JSON number can differ from what was
 * typed (`1e3` reads as `1000`), which is still a valid search.
 */

/** One query value as TanStack's JSON-first parser can deliver it. */
const queryValue = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value))

/**
 * An optional text or id parameter. A number or boolean reads as its text;
 * any other shape (a list, an object) reads as absent.
 */
export function searchText() {
  return queryValue.optional().catch(undefined)
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
