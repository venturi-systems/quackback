/**
 * Tests for external status name -> Quackback StatusId resolution.
 *
 * The external status name comes from an inbound webhook payload, so the lookup
 * must only ever find own keys of the stored mappings.
 */

import { describe, it, expect } from 'vitest'
import { generateId } from '@quackback/ids'
import { lookupStatusMapping, resolveStatusMapping, type StatusMappings } from '../status-mapping'

const IN_PROGRESS = generateId('status')
const DONE = generateId('status')

const MAPPINGS: StatusMappings = {
  'In Progress': IN_PROGRESS,
  Done: DONE,
  Backlog: null,
}

/** Names that a plain `mappings[name]` lookup resolves to an Object.prototype member. */
const INHERITED_KEYS = ['constructor', 'toString', 'hasOwnProperty', '__proto__']

describe('resolveStatusMapping', () => {
  it('resolves a mapped external status to its status id', () => {
    expect(resolveStatusMapping('In Progress', MAPPINGS)).toBe(IN_PROGRESS)
    expect(resolveStatusMapping('Done', MAPPINGS)).toBe(DONE)
  })

  it('returns null for an ignored, unmapped or differently cased status', () => {
    expect(resolveStatusMapping('Backlog', MAPPINGS)).toBeNull()
    expect(resolveStatusMapping('Cancelled', MAPPINGS)).toBeNull()
    expect(resolveStatusMapping('done', MAPPINGS)).toBeNull()
  })

  it('returns null when no mappings are configured', () => {
    expect(resolveStatusMapping('Done', undefined)).toBeNull()
    expect(resolveStatusMapping('Done', {})).toBeNull()
  })

  it.each(INHERITED_KEYS)('returns no mapping for the external status %s', (externalStatus) => {
    // Precondition: a plain lookup finds an inherited member for this name.
    expect((MAPPINGS as Record<string, unknown>)[externalStatus]).toBeDefined()

    expect(resolveStatusMapping(externalStatus, MAPPINGS)).toBeNull()
    expect(lookupStatusMapping(MAPPINGS, externalStatus)).toBeNull()
  })

  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'resolves a mapping genuinely stored under the external status name %s',
    (externalStatus) => {
      const mappings: StatusMappings = { [externalStatus]: DONE }
      expect(resolveStatusMapping(externalStatus, mappings)).toBe(DONE)
    }
  )

  it('treats an own __proto__ key in a parsed row as data', () => {
    // JSON.parse defines "__proto__" as an own property, as the jsonb driver does.
    const mappings = JSON.parse(`{"__proto__": "${DONE}"}`) as StatusMappings
    expect(Object.hasOwn(mappings, '__proto__')).toBe(true)
    expect(resolveStatusMapping('__proto__', mappings)).toBe(DONE)
  })

  it('returns null when the stored value is not a status TypeID', () => {
    const mappings = {
      text: 'not-an-id',
      otherEntity: generateId('post'),
      empty: '',
      number: 42,
      object: {},
    } as unknown as StatusMappings

    for (const externalStatus of Object.keys(mappings)) {
      expect(resolveStatusMapping(externalStatus, mappings)).toBeNull()
    }
  })

  it('returns null for an external status that is not a string', () => {
    expect(resolveStatusMapping(42 as unknown as string, MAPPINGS)).toBeNull()
    expect(resolveStatusMapping(null as unknown as string, MAPPINGS)).toBeNull()
  })
})

describe('lookupStatusMapping', () => {
  it('returns the stored value for an own key', () => {
    expect(lookupStatusMapping(MAPPINGS, 'Done')).toBe(DONE)
  })

  it('returns null for an ignored or unmapped status, or no mappings', () => {
    expect(lookupStatusMapping(MAPPINGS, 'Backlog')).toBeNull()
    expect(lookupStatusMapping(MAPPINGS, 'Cancelled')).toBeNull()
    expect(lookupStatusMapping(undefined, 'Done')).toBeNull()
  })
})
