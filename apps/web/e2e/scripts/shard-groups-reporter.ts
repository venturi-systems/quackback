/**
 * Record this shard's Playwright test groups for compute-shard-weights.ts.
 *
 * Playwright shards whole test GROUPS, not tests (filterForShard). Which
 * tests share a group depends on suite modes, beforeAll/afterAll hooks and
 * worker-scoped options such as `trace`, none of which a JSON report shows.
 * Getting any of them wrong is how an earlier weight model put the slow
 * serial files on the shards it believed were light. So this reporter reads
 * the groups from Playwright's own objects, mirroring createTestGroups
 * (Playwright 1.65), and writes them next to e2e-results.json.
 *
 * It observes only: it never filters, skips or reorders a test, and it
 * never throws. If Playwright's internals change shape it writes an `error`
 * field instead, and compute-shard-weights.ts refuses to use the file.
 */
import { readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { FullConfig, Reporter, Suite, TestCase } from '@playwright/test/reporter'

type Internal = TestCase & {
  _workerHash?: string
  _requireFile?: string
  parent: Suite & { _parallelMode?: string; _hooks?: { type: string }[] }
}

export type GroupsFile = {
  schema: 1
  shard: { current: number; total: number } | null
  groups: {
    project: string
    /** The project's position in the config: Playwright groups projects in that order. */
    projectIndex: number
    /** Opaque worker hash. Within a project, groups are bucketed by it. */
    workerHash: string
    file: string
    /** The file's position in Playwright's collection order for its project. */
    fileIndex: number
    kind: 'general' | 'parallel' | 'hooks'
    tests: { key: string; skipped: boolean }[]
  }[]
  error?: string
}

/**
 * Every file under `dir` in the order Playwright's collectFiles visits them:
 * depth first, each directory's entries sorted by name.localeCompare. Run in
 * Playwright's own process, so the comparator and its locale are the same.
 */
function collectionOrder(dir: string, into: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return into
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectionOrder(full, into)
    else if (entry.isFile()) into.push(full)
  }
  return into
}

export default class ShardGroupsReporter implements Reporter {
  private readonly outputFile: string

  constructor(options: { outputFile?: string } = {}) {
    this.outputFile = options.outputFile ?? 'e2e-groups.json'
  }

  printsToStdio(): boolean {
    return false
  }

  onBegin(config: FullConfig, suite: Suite): void {
    const target = resolve(dirname(config.configFile ?? `${process.cwd()}/x`), this.outputFile)
    const out: GroupsFile = { schema: 1, shard: config.shard ?? null, groups: [] }
    try {
      // filterForShard detaches dependency projects before it counts, and
      // Playwright adds them back to every shard afterwards.
      const dependencies = new Set<string>()
      for (const project of config.projects) {
        for (const name of project.dependencies) dependencies.add(name)
        if (project.teardown) dependencies.add(project.teardown)
      }
      for (const projectSuite of suite.suites) {
        const project = projectSuite.title
        if (dependencies.has(project)) continue
        const projectIndex = config.projects.findIndex((p) => p.name === project)
        const testDir = config.projects[projectIndex]?.testDir
        if (!testDir) throw new Error(`project ${project} is not in the config`)
        const order = new Map(collectionOrder(testDir).map((file, index) => [file, index]))
        type Bucket = { general: TestCase[]; parallel: Map<unknown, TestCase[]>; hooks: TestCase[] }
        const byWorker = new Map<string, Map<string, Bucket>>()
        for (const test of projectSuite.allTests() as Internal[]) {
          if (typeof test._workerHash !== 'string' || typeof test._requireFile !== 'string')
            throw new Error('TestCase no longer exposes _workerHash/_requireFile')
          let byFile = byWorker.get(test._workerHash)
          if (!byFile) byWorker.set(test._workerHash, (byFile = new Map()))
          let bucket = byFile.get(test._requireFile)
          if (!bucket)
            byFile.set(
              test._requireFile,
              (bucket = { general: [], parallel: new Map(), hooks: [] })
            )
          let insideParallel = false
          let hasAllHooks = false
          let outer: unknown
          for (let parent = test.parent as Internal['parent'] | undefined; parent;) {
            if (!Array.isArray(parent._hooks) || typeof parent._parallelMode !== 'string')
              throw new Error('Suite no longer exposes _hooks/_parallelMode')
            if (parent._parallelMode === 'serial' || parent._parallelMode === 'default')
              outer = parent
            insideParallel ||= parent._parallelMode === 'parallel'
            hasAllHooks ||= parent._hooks.some(
              (h) => h.type === 'beforeAll' || h.type === 'afterAll'
            )
            parent = parent.parent as Internal['parent'] | undefined
          }
          if (!insideParallel) bucket.general.push(test)
          else if (hasAllHooks && !outer) bucket.hooks.push(test)
          else {
            const key = outer ?? test
            const group = bucket.parallel.get(key)
            if (group) group.push(test)
            else bucket.parallel.set(key, [test])
          }
        }
        const entry = (tests: TestCase[]) =>
          tests.map((test) => ({
            key: [
              project,
              relative(config.rootDir, test.location.file),
              ...test.titlePath().slice(3),
            ].join(' › '),
            skipped: test.expectedStatus === 'skipped',
          }))
        for (const [workerHash, byFile] of byWorker) {
          for (const [requireFile, bucket] of byFile) {
            const fileIndex = order.get(requireFile)
            if (fileIndex === undefined) throw new Error(`${requireFile} is not under ${testDir}`)
            const base = {
              project,
              projectIndex,
              workerHash,
              file: relative(config.rootDir, requireFile),
              fileIndex,
            }
            if (bucket.general.length)
              out.groups.push({ ...base, kind: 'general', tests: entry(bucket.general) })
            for (const tests of bucket.parallel.values())
              out.groups.push({ ...base, kind: 'parallel', tests: entry(tests) })
            // Playwright chunks these by ceil(n / shard total) over the WHOLE
            // file, which one shard cannot see; the script re-chunks them.
            if (bucket.hooks.length)
              out.groups.push({ ...base, kind: 'hooks', tests: entry(bucket.hooks) })
          }
        }
      }
    } catch (error) {
      out.groups = []
      out.error = (error as Error).message
    }
    try {
      writeFileSync(target, `${JSON.stringify(out)}\n`)
    } catch {
      // Observing must never fail the run; the missing file fails the script.
    }
  }
}
