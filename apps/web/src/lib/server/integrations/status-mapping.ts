/**
 * Status mapping resolution.
 *
 * Maps external platform status names to Quackback StatusIds
 * using the statusMappings stored in integrations.config.
 */

import { isTypeId, type StatusId } from '@quackback/ids'

/**
 * Status mappings stored in integrations.config.statusMappings.
 * Key = external status name (case-sensitive as received from platform).
 * Value = Quackback StatusId or null (ignore this status).
 */
export type StatusMappings = Record<string, string | null>

/**
 * Read the value stored for one external status name.
 *
 * The name comes from outside the program: an inbound webhook payload, or the
 * status list an external platform returns. Indexing a plain object with it is
 * unsafe, because `constructor`, `toString`, `hasOwnProperty` or `__proto__`
 * resolve to inherited Object.prototype members rather than to a mapping. Only
 * an own property that holds a string counts. Everything else, including an
 * explicit null ("ignore this status"), returns null.
 *
 * The keys are not stripped or rejected: an external status may legitimately be
 * called `constructor`. Read through this function, such a key is only data.
 */
export function lookupStatusMapping(
  mappings: StatusMappings | undefined,
  externalStatus: string
): string | null {
  if (!mappings || typeof mappings !== 'object' || typeof externalStatus !== 'string') return null
  if (!Object.hasOwn(mappings, externalStatus)) return null
  const value = mappings[externalStatus]
  return typeof value === 'string' ? value : null
}

/**
 * Resolve an external status name to a Quackback StatusId.
 * Returns null if no mapping exists, the mapping explicitly says to ignore, or
 * the stored value is not a status TypeID.
 */
export function resolveStatusMapping(
  externalStatus: string,
  mappings: StatusMappings | undefined
): StatusId | null {
  const mapped = lookupStatusMapping(mappings, externalStatus)
  if (mapped === null || !isTypeId(mapped, 'status')) return null
  return mapped
}
