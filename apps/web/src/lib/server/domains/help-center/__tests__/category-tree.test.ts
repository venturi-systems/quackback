import { describe, it, expect } from 'vitest'
import {
  MAX_CATEGORY_DEPTH,
  collectDescendantIds,
  collectDescendantIdsIncludingSelf,
  computeRecursiveCounts,
  getCategoryDepth,
  getSubtreeMaxDepth,
  buildAncestorChain,
} from '../category-tree'

type TestCat = { id: string; parentId: string | null }

/**
 * Fixture tree:
 *   a (top)
 *   ├── b
 *   │   └── d
 *   └── c
 *   e (top, sibling of a)
 */
const flat: TestCat[] = [
  { id: 'a', parentId: null },
  { id: 'b', parentId: 'a' },
  { id: 'c', parentId: 'a' },
  { id: 'd', parentId: 'b' },
  { id: 'e', parentId: null },
]

describe('MAX_CATEGORY_DEPTH', () => {
  it('is 3', () => {
    expect(MAX_CATEGORY_DEPTH).toBe(3)
  })
})

describe('collectDescendantIds', () => {
  it('returns an empty set for a leaf', () => {
    expect(collectDescendantIds(flat, 'd')).toEqual(new Set())
  })
  it('returns direct children and grandchildren', () => {
    expect(collectDescendantIds(flat, 'a')).toEqual(new Set(['b', 'c', 'd']))
  })
  it('returns only direct child when there is one level', () => {
    expect(collectDescendantIds(flat, 'b')).toEqual(new Set(['d']))
  })
  it('returns an empty set when the id does not exist', () => {
    expect(collectDescendantIds(flat, 'zzz')).toEqual(new Set())
  })
})

describe('collectDescendantIdsIncludingSelf', () => {
  it('includes the root id plus all descendants', () => {
    expect(collectDescendantIdsIncludingSelf(flat, 'a')).toEqual(new Set(['a', 'b', 'c', 'd']))
  })
  it('returns just the id for a leaf', () => {
    expect(collectDescendantIdsIncludingSelf(flat, 'd')).toEqual(new Set(['d']))
  })
  it('returns an empty set when the id does not exist', () => {
    expect(collectDescendantIdsIncludingSelf(flat, 'zzz')).toEqual(new Set())
  })
})

describe('getCategoryDepth', () => {
  it('returns 0 for top-level categories', () => {
    expect(getCategoryDepth(flat, 'a')).toBe(0)
    expect(getCategoryDepth(flat, 'e')).toBe(0)
  })
  it('returns 1 for direct children of top-level', () => {
    expect(getCategoryDepth(flat, 'b')).toBe(1)
    expect(getCategoryDepth(flat, 'c')).toBe(1)
  })
  it('returns 2 for grandchildren', () => {
    expect(getCategoryDepth(flat, 'd')).toBe(2)
  })
  it('returns 0 for unknown id (treated as new top-level)', () => {
    expect(getCategoryDepth(flat, 'zzz')).toBe(0)
  })
})

describe('getSubtreeMaxDepth', () => {
  it('returns 0 for a leaf', () => {
    expect(getSubtreeMaxDepth(flat, 'd')).toBe(0)
    expect(getSubtreeMaxDepth(flat, 'c')).toBe(0)
    expect(getSubtreeMaxDepth(flat, 'e')).toBe(0)
  })
  it('returns 1 for a category with one level of children', () => {
    expect(getSubtreeMaxDepth(flat, 'b')).toBe(1)
  })
  it('returns 2 for a category with two levels of children', () => {
    expect(getSubtreeMaxDepth(flat, 'a')).toBe(2)
  })
  it('returns 0 when the id does not exist', () => {
    expect(getSubtreeMaxDepth(flat, 'zzz')).toBe(0)
  })
})

describe('computeRecursiveCounts', () => {
  it('returns the direct count for a leaf category', () => {
    const out = computeRecursiveCounts(flat, (id) => (id === 'd' ? 3 : 0))
    expect(out.get('d')).toBe(3)
  })

  it('propagates a descendant count up to every ancestor', () => {
    // Only d has articles; a and b should both report 3.
    const out = computeRecursiveCounts(flat, (id) => (id === 'd' ? 3 : 0))
    expect(out.get('b')).toBe(3)
    expect(out.get('a')).toBe(3)
    // c is a sibling of b with no articles anywhere beneath
    expect(out.get('c')).toBe(0)
    // e is an unrelated root
    expect(out.get('e')).toBe(0)
  })

  it('sums counts from multiple descendants into a shared ancestor', () => {
    // c has 2 direct; d (under b) has 5. Both roll up into a.
    const direct = new Map([
      ['c', 2],
      ['d', 5],
    ])
    const out = computeRecursiveCounts(flat, (id) => direct.get(id) ?? 0)
    expect(out.get('b')).toBe(5)
    expect(out.get('c')).toBe(2)
    expect(out.get('a')).toBe(7)
  })

  it('includes the direct count on the category itself', () => {
    // b has 4 direct articles and d (its child) has 1.
    const direct = new Map([
      ['b', 4],
      ['d', 1],
    ])
    const out = computeRecursiveCounts(flat, (id) => direct.get(id) ?? 0)
    expect(out.get('b')).toBe(5)
    expect(out.get('a')).toBe(5)
  })

  it('returns a map with an entry for every category, defaulting to 0', () => {
    const out = computeRecursiveCounts(flat, () => 0)
    expect(out.size).toBe(flat.length)
    for (const cat of flat) {
      expect(out.get(cat.id)).toBe(0)
    }
  })

  it('terminates when the input contains a cycle', () => {
    const cyclic: TestCat[] = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ]
    // Must not hang. Exact values in a cycle are unspecified, only termination
    // and non-negativity are contracts we care about.
    const out = computeRecursiveCounts(cyclic, () => 1)
    expect(out.size).toBe(2)
    expect(out.get('x')).toBeGreaterThanOrEqual(1)
    expect(out.get('y')).toBeGreaterThanOrEqual(1)
  })
})

describe('buildAncestorChain', () => {
  it('returns only the category itself for a top-level node', () => {
    expect(buildAncestorChain(flat, 'a').map((c) => c.id)).toEqual(['a'])
  })
  it('walks up to the root for a leaf', () => {
    expect(buildAncestorChain(flat, 'd').map((c) => c.id)).toEqual(['a', 'b', 'd'])
  })
  it('returns an empty array when the id does not exist', () => {
    expect(buildAncestorChain(flat, 'zzz')).toEqual([])
  })
  it('bails out of a cycle rather than looping forever', () => {
    // Corrupted fixture where a -> b -> a (would never happen via the service,
    // but the helper must not hang if the DB somehow contains a cycle)
    const cyclic: TestCat[] = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]
    expect(() => buildAncestorChain(cyclic, 'a')).not.toThrow()
    const chain = buildAncestorChain(cyclic, 'a')
    // Should terminate without repeating
    expect(chain.length).toBeLessThanOrEqual(2)
  })
})
