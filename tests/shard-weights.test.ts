import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assignShards,
  bestWeights,
  buildGroups,
  type Group,
} from '../apps/web/e2e/scripts/compute-shard-weights'
import type { GroupsFile } from '../apps/web/e2e/scripts/shard-groups-reporter'

/**
 * Playwright's own filterForShard, lifted from the installed runner. The
 * weight script reproduces it to choose cut points and to prove its model on
 * a measured run; if a Playwright upgrade changes how it shards, this file is
 * where that shows up first.
 */
function playwrightFilterForShard(): (
  shard: { current: number; total: number },
  weights: number[] | undefined,
  groups: { tests: { expectedStatus: string }[] }[]
) => Set<unknown> {
  const fromWeb = createRequire(join(process.cwd(), 'apps', 'web', 'package.json'))
  const testPkg = fromWeb.resolve('@playwright/test/package.json')
  // The runner bundle is not an exported subpath, so locate it by package root.
  const playwrightPkg = createRequire(testPkg).resolve('playwright/package.json')
  const runner = join(dirname(playwrightPkg), 'lib', 'runner', 'index.js')
  const source = readFileSync(runner, 'utf8')
  const start = source.indexOf('function filterForShard(')
  expect(start, 'Playwright no longer defines filterForShard').toBeGreaterThan(-1)
  let depth = 0
  let end = source.indexOf('{', start)
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++
    else if (source[end] === '}' && --depth === 0) break
  }
  const body = source.slice(start, end + 1)
  return new Function(`${body}; return filterForShard;`)()
}

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const group = (size: number, cost: number, skipped = 0): Group => ({
  file: 'f',
  tests: Array.from({ length: size }, (_, i) => `t${i}`),
  active: size - skipped,
  cost,
})

describe('compute-shard-weights reproduces Playwright sharding', () => {
  it('assigns every group exactly where Playwright 1.65 filterForShard does', () => {
    const filterForShard = playwrightFilterForShard()
    const random = seeded(7)
    for (let round = 0; round < 300; round++) {
      const total = 2 + Math.floor(random() * 7)
      const groups = Array.from({ length: 5 + Math.floor(random() * 60) }, () => {
        const size = 1 + Math.floor(random() * (random() < 0.1 ? 30 : 2))
        const skipped = random() < 0.15 ? Math.ceil(random() * size) : 0
        return group(size, 1, skipped)
      })
      const weights = Array.from({ length: total }, () => 1 + Math.floor(random() * 50))
      const ours = assignShards(groups, weights)
      const playwrightGroups = groups.map((g) => ({
        tests: g.tests.map((_, i) => ({ expectedStatus: i < g.active ? 'passed' : 'skipped' })),
      }))
      for (let shard = 1; shard <= total; shard++) {
        const picked = filterForShard({ current: shard, total }, weights, playwrightGroups)
        const expected = playwrightGroups.map((g) => picked.has(g))
        expect(ours.map((s) => s === shard - 1)).toEqual(expected)
      }
    }
  })

  it('emits weights that are the exact shard sizes of the best contiguous split', () => {
    // One indivisible 40-test group that costs as much as everything else
    // together: it has to sit alone, whatever its count.
    const groups = [...Array.from({ length: 30 }, () => group(1, 10)), group(40, 300)]
    const weights = bestWeights(groups, 2)
    expect(weights).toEqual([30, 40])
    const shards = assignShards(groups, weights)
    expect(shards.slice(0, 30).every((s) => s === 0)).toBe(true)
    expect(shards[30]).toBe(1)
  })

  it('never empties a shard and covers every group once', () => {
    const random = seeded(11)
    for (let round = 0; round < 50; round++) {
      const groups = Array.from({ length: 20 + Math.floor(random() * 80) }, () =>
        group(1 + Math.floor(random() * 3), random() * 1000)
      )
      const weights = bestWeights(groups, 8)
      expect(weights).toHaveLength(8)
      expect(weights.every((w) => w > 0)).toBe(true)
      expect(weights.reduce((a, b) => a + b, 0)).toBe(groups.reduce((n, g) => n + g.active, 0))
      const shards = assignShards(groups, weights)
      expect(new Set(shards).size).toBe(8)
    }
  })
})

describe('compute-shard-weights rebuilds the run-wide group order', () => {
  const file = (current: number, groups: Partial<GroupsFile['groups'][number]>[]): GroupsFile => ({
    schema: 1,
    shard: { current, total: 2 },
    groups: groups.map((g) => ({
      project: 'p',
      projectIndex: 0,
      workerHash: 'a',
      file: 'x.spec.ts',
      fileIndex: 0,
      kind: 'parallel',
      tests: [],
      ...g,
    })),
  })
  const t = (key: string) => ({ key, skipped: false })

  it('puts a later worker-hash bucket after every file of the earlier one', () => {
    // Shard 2 lists its `trace`-scoped file first, because inside one shard
    // that file is the first it meets. Across the run, Playwright buckets by
    // worker hash in order of first appearance, so it belongs last.
    const { groups, origin } = buildGroups(
      [
        file(1, [{ file: 'a.spec.ts', fileIndex: 0, tests: [t('a1')] }]),
        file(2, [
          { file: 'b-design.spec.ts', fileIndex: 1, workerHash: 'trace', tests: [t('d1')] },
          { file: 'c.spec.ts', fileIndex: 2, tests: [t('c1')] },
        ]),
      ],
      () => 1,
      2
    )
    expect(groups.map((g) => g.tests[0])).toEqual(['a1', 'c1', 'd1'])
    expect(origin).toEqual([0, 1, 1])
  })

  it('joins a file split across shards and re-chunks its hook tests over the whole file', () => {
    const hooks = (keys: string[]) => ({ kind: 'hooks' as const, tests: keys.map(t) })
    const { groups, origin } = buildGroups(
      [file(1, [hooks(['h1', 'h2', 'h3'])]), file(2, [hooks(['h4', 'h5'])])],
      () => 1,
      2
    )
    // ceil(5 / 2) = 3 tests per chunk over the whole file.
    expect(groups.map((g) => g.tests)).toEqual([
      ['h1', 'h2', 'h3'],
      ['h4', 'h5'],
    ])
    expect(origin).toEqual([0, 1])
  })
})
