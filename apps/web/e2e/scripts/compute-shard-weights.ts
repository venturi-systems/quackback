#!/usr/bin/env bun
/**
 * Derive PWTEST_SHARD_WEIGHTS from measured test durations.
 *
 *   bun e2e/scripts/compute-shard-weights.ts ./shard-1/e2e-results.json ...
 *
 * `--shard=i/N` splits by test COUNT: Playwright's filterForShard sums
 * group.tests.length and cuts at equal counts. Durations in this suite span
 * three orders of magnitude, so equal counts produce very unequal work.
 * PWTEST_SHARD_WEIGHTS moves those cut points; each weight is a shard's share
 * of the total count, so a shard of slow tests is given fewer tests.
 *
 * This reads the Playwright JSON reports from a full CI run (download the
 * `playwright-shard-*` artifacts), walks the tests in Playwright's own order,
 * and picks the N contiguous ranges whose slowest member is shortest. Print
 * the vector into the `PWTEST_SHARD_WEIGHTS` value in .github/workflows/ci.yml.
 *
 * This only moves boundaries. filterForShard assigns every group to exactly
 * one shard for any weight vector, so no vector this emits can drop or
 * duplicate a test -- tests/ci-contract.test.ts holds that line.
 *
 * Ordering note: the reports are merged by (file, line, column), which is the
 * order Playwright itself shards in. Passing the shard reports in any order is
 * therefore fine; passing reports from DIFFERENT runs is not, because the
 * union would not be one coherent suite.
 */
import { existsSync, readFileSync } from 'node:fs'

const paths = process.argv.slice(2)
const SHARDS = Number(process.env.SHARD_TOTAL ?? 8)

if (paths.length === 0) {
  console.error('usage: compute-shard-weights.ts <playwright-json-report>...')
  console.error('       SHARD_TOTAL=8 by default; pass every shard report from ONE run.')
  process.exit(2)
}

if (!Number.isInteger(SHARDS) || SHARDS < 2) {
  console.error(`FATAL: SHARD_TOTAL=${process.env.SHARD_TOTAL} is not an integer >= 2`)
  process.exit(2)
}

type Spec = { line: number; column: number; tests?: { results?: { duration?: number }[] }[] }
type Suite = { file?: string; specs?: Spec[]; suites?: Suite[] }

const tests = new Map<string, { file: string; line: number; column: number; duration: number }>()

for (const path of paths) {
  if (!existsSync(path)) {
    console.error(`FATAL: no such report: ${path}`)
    process.exit(1)
  }
  let report: { suites?: Suite[] }
  try {
    report = JSON.parse(readFileSync(path, 'utf8')) as { suites?: Suite[] }
  } catch (error) {
    console.error(`FATAL: ${path} is not valid JSON: ${(error as Error).message}`)
    process.exit(1)
  }

  const walk = (suite: Suite, inherited?: string) => {
    const file = suite.file ?? inherited
    for (const spec of suite.specs ?? []) {
      if (!file) continue
      // One spec location is one Playwright test here: the projects in
      // playwright.config.ts partition spec files by directory and nothing sets
      // repeatEach, so every spec carries exactly one `tests` entry. The setup
      // and cleanup dependency tests also land in `ordered`, although
      // filterForShard detaches dependency suites before it counts, so they add
      // a small constant to shard 1's share only. Playwright applies the weights
      // proportionally (floor(weight * total / sum)), so even a uniform
      // multiplicity would leave the cut points where this script drew them.
      // Sum every result: a retried test costs the shard its retries too, and
      // the boundaries have to be drawn against what the shard actually pays.
      const duration = (spec.tests ?? [])
        .flatMap((t) => t.results ?? [])
        .reduce((total, r) => total + (r.duration ?? 0), 0)
      const key = `${file}:${spec.line}:${spec.column}`
      const seen = tests.get(key)
      if (seen) seen.duration += duration
      else tests.set(key, { file, line: spec.line, column: spec.column, duration })
    }
    for (const child of suite.suites ?? []) walk(child, file)
  }
  for (const suite of report.suites ?? []) walk(suite)
}

if (tests.size === 0) {
  console.error('FATAL: the reports contain no tests; refusing to emit a weight vector')
  process.exit(1)
}

const ordered = [...tests.values()].sort(
  (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column
)
const total = ordered.reduce((sum, t) => sum + t.duration, 0)

if (total <= 0) {
  console.error('FATAL: the reports carry no durations; refusing to emit a weight vector')
  process.exit(1)
}

const target = total / SHARDS

// Cut where the slowest shard is as short as it can be.
//
// The first version cut the moment the running total crossed the next 1/N.
// That overshoots whenever one spec is long: the shard that absorbs it
// finishes late, and the next shard, cut early to catch up, finishes early.
// On run 37513233008 it drew shards of 683 s and 288 s against a 507 s mean.
// The contiguous split with the smallest maximum is found instead: binary
// search the cap, fill shards greedily under it, and when that needs fewer
// than N shards, split the slowest ones, which never raises the maximum.
const partition = (cap: number): number[] => {
  const counts: number[] = []
  let count = 0
  let sum = 0
  for (const test of ordered) {
    if (count > 0 && sum + test.duration > cap) {
      counts.push(count)
      count = 0
      sum = 0
    }
    count += 1
    sum += test.duration
  }
  counts.push(count)
  return counts
}

let low = Math.max(...ordered.map((t) => t.duration))
let high = total
while (high - low > 1) {
  const mid = (low + high) / 2
  if (partition(mid).length <= SHARDS) high = mid
  else low = mid
}
const weights = partition(high)

const durationOf = (start: number, count: number): number =>
  ordered.slice(start, start + count).reduce((sum, t) => sum + t.duration, 0)

while (weights.length < SHARDS) {
  let pick = -1
  let pickStart = 0
  let pickDuration = -1
  let start = 0
  for (const [index, weight] of weights.entries()) {
    const duration = durationOf(start, weight)
    if (weight > 1 && duration > pickDuration) {
      pick = index
      pickStart = start
      pickDuration = duration
    }
    start += weight
  }
  if (pick < 0) break // fewer tests than shards; the guard below reports it
  // Split the slowest shard at the point closest to half its duration.
  let best = 1
  let bestGap = Number.POSITIVE_INFINITY
  let accumulated = 0
  for (let k = 1; k < weights[pick]; k++) {
    accumulated += ordered[pickStart + k - 1].duration
    const gap = Math.abs(accumulated - pickDuration / 2)
    if (gap < bestGap) {
      bestGap = gap
      best = k
    }
  }
  weights.splice(pick, 1, best, weights[pick] - best)
}

// A zero weight would hand a shard no tests at all, and an empty shard cannot
// prove anything. check-known-failures.ts would reject it, but emitting one at
// all is a bug in this script, so stop here rather than shipping it.
if (weights.length !== SHARDS || weights.some((w) => w <= 0)) {
  console.error(`FATAL: computed a non-positive weight (${weights.join(':')}); refusing to emit it`)
  process.exit(1)
}

console.error(
  `${ordered.length} tests, ${(total / 1000 / 60).toFixed(1)} min measured, ${SHARDS} shards`
)
console.error(`target per shard: ${(target / 1000 / 60).toFixed(1)} min`)
let offset = 0
for (const [index, weight] of weights.entries()) {
  const slice = ordered.slice(offset, offset + weight)
  const seconds = slice.reduce((sum, t) => sum + t.duration, 0) / 1000
  console.error(
    `  shard ${index + 1}: ${String(weight).padStart(4)} tests  ${seconds.toFixed(0).padStart(5)}s`
  )
  offset += weight
}
console.log(weights.join(':'))
