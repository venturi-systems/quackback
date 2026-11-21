#!/usr/bin/env bun
/**
 * Derive PWTEST_SHARD_WEIGHTS from measured test durations.
 *
 *   bun e2e/scripts/compute-shard-weights.ts <artifact-dir-or-json>...
 *
 * Pass every `playwright-shard-*` artifact of one or more CI runs of the
 * same suite. Each holds the shard's results (`e2e-results.json`) and its
 * test groups (`e2e-groups.json`, written by shard-groups-reporter.ts).
 * Directories are searched for both files. With several runs, each test is
 * costed at the median of its runs. Every run must have used the weights
 * the self-check replays.
 *
 * How Playwright shards (filterForShard, Playwright 1.65):
 *
 *  1. It builds test GROUPS per project (createTestGroups), ordered by
 *     worker hash, then file. With fullyParallel a test is its own group,
 *     unless an enclosing suite is `serial` or `default` mode: then every
 *     test under the outermost such suite is one indivisible group. Tests
 *     under a beforeAll/afterAll hook with no sequential suite are cut into
 *     ceil(n / shardTotal) chunks after the file's other groups. A file that
 *     sets a worker-scoped option such as `trace` gets its own worker hash,
 *     so its groups move to the END of the project.
 *  2. It sizes each group by its tests whose expectedStatus is not 'skipped'
 *     at load time (every test only when none is active). Dependency
 *     projects (setup, cleanup) are detached first and count for nothing.
 *  3. It cuts that count at floor(weight * total / sum) per shard, and a
 *     group goes wholly to the shard holding its starting position.
 *
 * The previous version of this script modelled none of that. It keyed tests
 * by source location, so a loop declaring several tests at one line counted
 * as one; it sorted files by path, which puts the `trace`-scoped design
 * files ahead of most of chromium-public while Playwright runs them last;
 * and it drew cuts inside serial groups that Playwright cannot split. Its
 * last vector summed to 808 against 984 shardable tests.
 *
 * This version takes the groups from Playwright itself (the reporter above
 * mirrors createTestGroups on the real test objects) and reproduces
 * filterForShard exactly. Before it emits anything it proves the model: it
 * replays the weights the measured run used (read from ci.yml, or
 * --current-weights) and refuses to continue unless every group lands on
 * the shard that actually ran it. It then picks the contiguous split of
 * groups whose slowest shard is shortest, costing each test at the sum of
 * its result durations (retries included), and prints each shard's
 * active-test count as the vector.
 *
 * This only moves boundaries. filterForShard assigns every group to exactly
 * one shard for any weight vector, so no vector this emits can drop or
 * duplicate a test -- tests/ci-contract.test.ts holds that line.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GroupsFile } from './shard-groups-reporter'

export type Group = { file: string; tests: string[]; active: number; cost: number }

type JsonTest = { projectName: string; results?: { duration?: number }[] }
type JsonSpec = { title: string; file?: string; tests?: JsonTest[] }
type JsonSuite = { title?: string; file?: string; specs?: JsonSpec[]; suites?: JsonSuite[] }
type JsonReport = {
  config?: { shard?: { current: number; total: number } | null }
  suites?: JsonSuite[]
}

/**
 * Every test in a Playwright JSON report, keyed the way the groups reporter
 * keys it: project, file relative to the test root, then the title path.
 */
export function walkReport(report: JsonReport, visit: (key: string, test: JsonTest) => void): void {
  const walk = (suite: JsonSuite, file: string | undefined, titles: string[]) => {
    const here = suite.file ?? file
    const path = suite.title && suite.title !== here ? [...titles, suite.title] : titles
    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? here
      if (!specFile) continue
      for (const test of spec.tests ?? [])
        visit([test.projectName, specFile, ...path, spec.title].join(' › '), test)
    }
    for (const child of suite.suites ?? []) walk(child, here, path)
  }
  for (const suite of report.suites ?? []) walk(suite, undefined, [])
}

/**
 * Rebuild the whole run's ordered group list from each shard's
 * e2e-groups.json, in createTestGroups' order: project, then worker-hash
 * bucket (in order of each bucket's first file), then file, then the order
 * the reporter listed the file's groups in, shard by shard. A shard sees
 * only its own files, so a bucket's place has to come from the collection
 * index of its first file across all shards rather than from any one shard.
 *
 * Hook groups are joined across shards and re-chunked here: Playwright cuts
 * a file's hook tests into ceil(n / shardTotal) chunks over the whole file.
 *
 * `origin` is the shard (0-based) each group actually ran on.
 */
export function buildGroups(
  files: GroupsFile[],
  cost: (key: string) => number,
  shardTotal: number
): { groups: Group[]; origin: number[] } {
  type Entry = GroupsFile['groups'][number] & { shard: number; seen: number }
  const entries: Entry[] = []
  for (const [shard, file] of files.entries())
    for (const group of file.groups) entries.push({ ...group, shard, seen: entries.length })

  const bucketRank = new Map<string, number>()
  for (const entry of entries) {
    const bucket = `${entry.projectIndex}\u0000${entry.workerHash}`
    const rank = bucketRank.get(bucket)
    if (rank === undefined || entry.fileIndex < rank) bucketRank.set(bucket, entry.fileIndex)
  }
  const rankOf = (e: Entry) => bucketRank.get(`${e.projectIndex}\u0000${e.workerHash}`)!
  entries.sort(
    (a, b) =>
      a.projectIndex - b.projectIndex ||
      rankOf(a) - rankOf(b) ||
      (a.workerHash < b.workerHash ? -1 : a.workerHash > b.workerHash ? 1 : 0) ||
      a.fileIndex - b.fileIndex ||
      a.seen - b.seen
  )

  const groups: Group[] = []
  const origin: number[] = []
  const shardOf = new Map<string, number>()
  for (const entry of entries) for (const test of entry.tests) shardOf.set(test.key, entry.shard)
  const push = (file: string, tests: { key: string; skipped: boolean }[]) => {
    groups.push({
      file,
      tests: tests.map((t) => t.key),
      active: tests.filter((t) => !t.skipped).length,
      cost: tests.reduce((sum, t) => sum + cost(t.key), 0),
    })
    origin.push(shardOf.get(tests[0].key)!)
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const file = `${entry.project} \u203a ${entry.file}`
    if (entry.kind !== 'hooks') {
      push(file, entry.tests)
      continue
    }
    const tests = [...entry.tests]
    while (
      i + 1 < entries.length &&
      entries[i + 1].kind === 'hooks' &&
      entries[i + 1].projectIndex === entry.projectIndex &&
      entries[i + 1].workerHash === entry.workerHash &&
      entries[i + 1].fileIndex === entry.fileIndex
    )
      tests.push(...entries[++i].tests)
    const chunk = Math.ceil(tests.length / shardTotal)
    for (let k = 0; k < tests.length; k += chunk) push(file, tests.slice(k, k + chunk))
  }
  return { groups, origin }
}

/** filterForShard, Playwright 1.65: the shard index (0-based) of each group. */
export function assignShards(groups: Group[], weights: number[]): number[] {
  const active = groups.map((g) => g.active)
  const sizesOf = active.some(Boolean) ? active : groups.map((g) => g.tests.length)
  const total = sizesOf.reduce((a, b) => a + b, 0)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const sizes = weights.map((w) => Math.floor((w * total) / weightSum))
  const remainder = total - sizes.reduce((a, b) => a + b, 0)
  for (let i = 0; i < remainder; i++) sizes[i % sizes.length]++
  const bounds: number[] = []
  let edge = 0
  for (const size of sizes) bounds.push((edge += size))
  let current = 0
  return groups.map((_, index) => {
    const position = sizesOf[index] ? current : Math.max(current - 1, 0)
    current += sizesOf[index]
    const shard = bounds.findIndex((b) => position < b)
    return shard < 0 ? weights.length - 1 : shard
  })
}

/**
 * The contiguous split of `groups` into `shards` ranges whose slowest range
 * is shortest, as each range's active-test count: the weight vector that
 * makes filterForShard cut exactly there.
 */
export function bestWeights(groups: Group[], shards: number): number[] {
  const partition = (cap: number): number[][] => {
    const ranges: number[][] = []
    let range: number[] = []
    let sum = 0
    for (const [index, group] of groups.entries()) {
      if (range.length > 0 && sum + group.cost > cap) {
        ranges.push(range)
        range = []
        sum = 0
      }
      range.push(index)
      sum += group.cost
    }
    ranges.push(range)
    return ranges
  }
  let low = Math.max(...groups.map((g) => g.cost))
  let high = groups.reduce((sum, g) => sum + g.cost, 0)
  for (let i = 0; i < 100 && high - low > 1e-6; i++) {
    const mid = (low + high) / 2
    if (partition(mid).length <= shards) high = mid
    else low = mid
  }
  const ranges = partition(high)
  // Fewer ranges than shards: split the slowest range at its group nearest
  // half its cost. That never raises the maximum.
  const costOf = (range: number[]) => range.reduce((sum, i) => sum + groups[i].cost, 0)
  while (ranges.length < shards) {
    let pick = -1
    for (const [index, range] of ranges.entries())
      if (range.length > 1 && (pick < 0 || costOf(range) > costOf(ranges[pick]))) pick = index
    if (pick < 0) break
    const range = ranges[pick]
    const half = costOf(range) / 2
    let best = 1
    let bestGap = Number.POSITIVE_INFINITY
    let accumulated = 0
    for (let k = 1; k < range.length; k++) {
      accumulated += groups[range[k - 1]].cost
      if (Math.abs(accumulated - half) < bestGap) {
        bestGap = Math.abs(accumulated - half)
        best = k
      }
    }
    ranges.splice(pick, 1, range.slice(0, best), range.slice(best))
  }
  const useActive = groups.some((g) => g.active > 0)
  return ranges.map((range) =>
    range.reduce((sum, i) => sum + (useActive ? groups[i].active : groups[i].tests.length), 0)
  )
}

function collectReports(paths: string[]): string[] {
  const files: string[] = []
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`no such report or directory: ${path}`)
    if (!statSync(path).isDirectory()) {
      files.push(path)
      continue
    }
    const stack = [path]
    while (stack.length) {
      const dir = stack.pop()!
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) stack.push(full)
        else if (name === 'e2e-groups.json' || name === 'e2e-results.json') files.push(full)
      }
    }
  }
  return files
}

function weightsFromWorkflow(): number[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const workflow = resolve(here, '../../../../.github/workflows/ci.yml')
  const match = readFileSync(workflow, 'utf8').match(/PWTEST_SHARD_WEIGHTS:\s*'([0-9:]+)'/)
  if (!match) throw new Error(`no PWTEST_SHARD_WEIGHTS in ${workflow}`)
  return match[1].split(':').map(Number)
}

function main(argv: string[]): number {
  let currentWeights: number[] | undefined
  const inputs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--current-weights') currentWeights = (argv[++i] ?? '').split(':').map(Number)
    else inputs.push(argv[i])
  }
  if (inputs.length === 0) {
    console.error('usage: compute-shard-weights.ts [--current-weights a:b:...] <artifact>...')
    console.error('       pass every playwright-shard-* artifact (groups + results) of each run;')
    console.error('       --current-weights defaults to the vector in .github/workflows/ci.yml')
    return 2
  }

  // One or more runs of the same suite. A second report for a shard is a
  // second run; its groups must match the first run's, and each test is
  // costed at the median of its runs, so one slow runner does not move a cut.
  const groupFiles = new Map<number, { path: string; text: string; parsed: GroupsFile }[]>()
  const results = new Map<number, JsonReport[]>()
  let shardTotal = 0
  for (const path of collectReports(inputs)) {
    const text = readFileSync(path, 'utf8')
    let parsed: GroupsFile & JsonReport
    try {
      parsed = JSON.parse(text) as GroupsFile & JsonReport
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, { cause: error })
    }
    const isGroups = 'schema' in parsed && Array.isArray(parsed.groups)
    if (isGroups && parsed.error) throw new Error(`${path}: the reporter failed: ${parsed.error}`)
    const shard = isGroups ? parsed.shard : parsed.config?.shard
    if (!shard) throw new Error(`${path} was not produced with --shard`)
    if (shardTotal && shard.total !== shardTotal) throw new Error(`${path}: mixed shard totals`)
    shardTotal = shard.total
    if (isGroups) {
      const list = groupFiles.get(shard.current) ?? []
      list.push({ path, text: JSON.stringify(parsed.groups), parsed })
      groupFiles.set(shard.current, list)
    } else results.set(shard.current, [...(results.get(shard.current) ?? []), parsed])
  }
  if (shardTotal < 2) throw new Error('need the reports of a run with at least 2 shards')
  const runs = groupFiles.get(1)?.length ?? 0
  for (let shard = 1; shard <= shardTotal; shard++) {
    const groups = groupFiles.get(shard) ?? []
    if (groups.length === 0 || groups.length !== runs || results.get(shard)?.length !== runs)
      throw new Error(
        `every shard of ${shardTotal} needs one e2e-groups.json and one e2e-results.json per run`
      )
    const differs = groups.find((g) => g.text !== groups[0].text)
    if (differs)
      throw new Error(`${differs.path} groups differ from ${groups[0].path}: mixed suites`)
  }
  currentWeights ??= weightsFromWorkflow()
  if (currentWeights.length !== shardTotal || currentWeights.some((w) => !(w > 0)))
    throw new Error(`current weights ${currentWeights.join(':')} do not fit ${shardTotal} shards`)

  const measured = new Map<string, number[]>()
  for (const reports of results.values()) {
    for (const report of reports) {
      walkReport(report, (key, test) => {
        const spent = (test.results ?? []).reduce((sum, r) => sum + (r.duration ?? 0), 0)
        measured.set(key, [...(measured.get(key) ?? []), spent])
      })
    }
  }
  const cost = new Map<string, number>()
  for (const [key, values] of measured) {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    cost.set(key, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2)
  }

  const files = Array.from({ length: shardTotal }, (_, i) => groupFiles.get(i + 1)![0].parsed)
  const { groups, origin } = buildGroups(files, (key) => cost.get(key) ?? 0, shardTotal)
  const unmeasured = groups.flatMap((g) => g.tests).filter((key) => !cost.has(key))
  if (unmeasured.length) {
    console.error(`FATAL: ${unmeasured.length} grouped tests have no result, e.g. ${unmeasured[0]}`)
    return 1
  }

  // Prove the model on the run it measured before trusting it.
  const replay = assignShards(groups, currentWeights)
  const wrong = groups.findIndex((_, i) => replay[i] !== origin[i])
  if (wrong >= 0) {
    console.error(
      `FATAL: under ${currentWeights.join(':')} the model puts ${groups[wrong].tests[0]} on ` +
        `shard ${replay[wrong] + 1}, but the run held it on shard ${origin[wrong] + 1}. ` +
        'The reports and the weights do not belong together, or Playwright changed how it shards.'
    )
    return 1
  }

  const weights = bestWeights(groups, shardTotal)
  // A zero weight would hand a shard no tests at all, and an empty shard cannot
  // prove anything. check-known-failures.ts would reject it, but emitting one at
  // all is a bug in this script, so stop here rather than shipping it.
  if (weights.length !== shardTotal || weights.some((w) => w <= 0)) {
    console.error(
      `FATAL: computed a non-positive weight (${weights.join(':')}); refusing to emit it`
    )
    return 1
  }

  const proposed = assignShards(groups, weights)
  const seconds = (shards: number[], index: number) =>
    groups.reduce((sum, g, i) => sum + (shards[i] === index ? g.cost : 0), 0) / 1000
  const total = groups.reduce((sum, g) => sum + g.cost, 0)
  const tests = groups.reduce((n, g) => n + g.tests.length, 0)
  console.error(
    `${tests} shardable tests in ${groups.length} groups, ${(total / 60000).toFixed(1)} min ` +
      `measured (median of ${runs} run${runs === 1 ? '' : 's'}), ${shardTotal} shards, mean ${(total / shardTotal / 1000).toFixed(0)}s; the ` +
      `model reproduces the run's shards under ${currentWeights.join(':')}`
  )
  for (let index = 0; index < shardTotal; index++) {
    const count = groups.reduce((n, g, i) => n + (proposed[i] === index ? g.tests.length : 0), 0)
    console.error(
      `  shard ${index + 1}: now ${seconds(replay, index).toFixed(0).padStart(4)}s, ` +
        `proposed ${seconds(proposed, index).toFixed(0).padStart(4)}s (${count} tests)`
    )
  }
  console.log(weights.join(':'))
  return 0
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error(`FATAL: ${(error as Error).message}`)
    process.exit(1)
  }
}
