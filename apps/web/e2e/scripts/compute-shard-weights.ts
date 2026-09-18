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
 * and cuts when cumulative duration crosses the next 1/N. Print the vector
 * into the `PWTEST_SHARD_WEIGHTS` value in .github/workflows/ci.yml.
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
const weights: number[] = []
let cut = 0
let accumulated = 0

ordered.forEach((test, index) => {
  accumulated += test.duration
  if (weights.length < SHARDS - 1 && accumulated >= target * (weights.length + 1)) {
    weights.push(index + 1 - cut)
    cut = index + 1
  }
})
weights.push(ordered.length - cut)

// A zero weight would hand a shard no tests at all, and an empty shard cannot
// prove anything. check-known-failures.ts would reject it, but emitting one at
// all is a bug in this script, so stop here rather than shipping it.
if (weights.some((w) => w <= 0)) {
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
