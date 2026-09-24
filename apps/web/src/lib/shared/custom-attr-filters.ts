/**
 * Custom attribute filters for the admin users list, in their URL form:
 * `key:op:value` parts joined by commas (`?customAttrs=plan:eq:pro,seats:gte:5`).
 * The route loader and the client list query both parse them here, so the two
 * always send the server the same filters.
 */

/** A parsed custom attribute filter. */
export interface ParsedCustomAttr {
  key: string
  op: string
  value: string
}

/** Operators that compare a custom attribute as a number. */
export const NUMERIC_ATTR_OPS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte'])

/**
 * Whether `value` is a finite number, the only thing a numeric operator can
 * compare with. Empty text is not a number here, although `Number('')` is 0.
 */
export function isFiniteAttrNumber(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value))
}

/**
 * Parse `key:op:value,key2:op:value2` into filters. A part without a key or an
 * operator is dropped. So is a numeric comparison (`gt`, `gte`, `lt`, `lte`)
 * whose value is not a finite number: `seats:gt:abc` has nothing to compare
 * with, so it is ignored instead of sent to the list query.
 */
export function parseCustomAttrs(raw?: string): ParsedCustomAttr[] | undefined {
  if (!raw) return undefined
  return raw
    .split(',')
    .map((part): ParsedCustomAttr | null => {
      const [key, op, ...rest] = part.split(':')
      return key && op ? { key, op, value: rest.join(':') } : null
    })
    .filter(
      (attr): attr is ParsedCustomAttr =>
        attr !== null && (!NUMERIC_ATTR_OPS.has(attr.op) || isFiniteAttrNumber(attr.value))
    )
}
