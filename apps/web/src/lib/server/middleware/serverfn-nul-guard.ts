/**
 * Server-function NUL guard (DEF-45, venturi-systems/landing-page#2309).
 *
 * Postgres cannot store a NUL character (U+0000) in any text value, and jsonb
 * rejects one in a string or a key. A NUL that reaches a query fails it, so
 * the call answers with a database error instead of a validation error. The
 * route search helpers (lib/shared/search-params.ts) already drop a NUL from
 * the URL, and the list schemas (lib/shared/schemas/list-filters.ts) refuse
 * one field by field. A server function is still an endpoint of its own,
 * though: a hand-made `/_serverFn/` call reaches its validator directly, and
 * most validators take plain `z.string()` text.
 *
 * `serverFnNulGuard` closes that for every server function at once. It runs as
 * a global function middleware, before the function's own validator, and
 * refuses a call whose input holds a NUL in any string value or object key,
 * at any depth. The refusal has the shape of a validator error (TanStack
 * Start's `execValidator` throws `JSON.stringify(issues)`), so the caller gets
 * the serialized validation error it would get from a zod refinement.
 *
 * Only data the app can store is walked: strings, arrays, plain objects,
 * `Map`, `Set` and `FormData` string entries. Everything else (a `Date`, a
 * `File` or `Blob`, typed arrays, class instances) passes untouched. The walk
 * is iterative and skips objects it has already seen, so a deep or cyclic
 * payload cannot overflow the stack.
 */
import { createMiddleware } from '@tanstack/react-start'

const NUL = '\u0000'

/** A path into the input, as zod reports issue paths. */
export type InputPath = Array<string | number>

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** One value still to visit, with the key that led to it from its parent. */
interface Pending {
  value: unknown
  key: string | number | null
  parent: Pending | null
}

function pathOf(node: Pending): InputPath {
  const path: InputPath = []
  for (let at: Pending | null = node; at && at.key !== null; at = at.parent) path.push(at.key)
  return path.reverse()
}

/**
 * The path of the first string value or object key in `input` that holds a
 * NUL, or `null` when there is none. A key holding a NUL is reported at the
 * path of its object. Each node records only its parent, so the walk stays
 * linear in the size of the input however deep it nests.
 */
export function findNulPath(input: unknown): InputPath | null {
  const stack: Pending[] = [{ value: input, key: null, parent: null }]
  const seen = new WeakSet<object>()

  for (let node = stack.pop(); node; node = stack.pop()) {
    const { value } = node
    if (typeof value === 'string') {
      if (value.includes(NUL)) return pathOf(node)
      continue
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) continue
    seen.add(value)

    const parent: Pending = node
    const visit = (key: string | number, entry: unknown) => {
      stack.push({ value: entry, key, parent })
    }
    if (Array.isArray(value)) {
      value.forEach((item: unknown, index) => visit(index, item))
    } else if (typeof FormData !== 'undefined' && value instanceof FormData) {
      for (const [key, entry] of value.entries()) {
        if (key.includes(NUL)) return pathOf(node)
        if (typeof entry === 'string') visit(key, entry)
      }
    } else if (value instanceof Map) {
      for (const [key, entry] of value) {
        if (typeof key === 'string' && key.includes(NUL)) return pathOf(node)
        visit(String(key), entry)
      }
    } else if (value instanceof Set) {
      let index = 0
      for (const entry of value) visit(index++, entry)
    } else if (isPlainObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (key.includes(NUL)) return pathOf(node)
        visit(key, entry)
      }
    }
  }
  return null
}

/** The message a refused call carries: one zod-style issue, as a validator throws it. */
export const NUL_INPUT_MESSAGE = 'Text must not contain NUL'

/** The validation-shaped error for an input holding a NUL at `path`. */
export function nulInputError(path: InputPath): Error {
  return new Error(
    JSON.stringify([{ code: 'custom', path, message: NUL_INPUT_MESSAGE }], undefined, 2)
  )
}

/**
 * Global function middleware: refuses a server-function call whose input holds
 * a NUL, before the function's validator or handler runs. Register it after
 * `serverFnDispatchMarker`, which must stay first.
 */
export const serverFnNulGuard = createMiddleware({ type: 'function' }).server(({ data, next }) => {
  const path = findNulPath(data)
  if (path) throw nulInputError(path)
  return next()
})
