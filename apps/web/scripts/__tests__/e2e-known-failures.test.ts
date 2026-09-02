import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectOutcomes,
  MIN_TESTS_PER_SHARD,
  ratchet,
  testId,
  type JsonReport,
} from '../../e2e/scripts/known-failures'

/**
 * The e2e ratchet is the gate that lets a suite with known failures be enrolled
 * in CI honestly. If IT is wrong, the lane goes back to being decoration -- so
 * every branch that can turn a shard green is exercised here, including the
 * fail-closed ones.
 */

/** A report shaped exactly like Playwright's, verified against 1.62.1 output. */
function report(
  specs: Array<{ file: string; describe?: string; title: string; project: string; status: string }>
): JsonReport {
  const byFile = new Map<string, JsonReport['suites']>()
  const suites: NonNullable<JsonReport['suites']> = []
  for (const s of specs) {
    let fileSuite = suites.find((x) => x.title === s.file)
    if (!fileSuite) {
      fileSuite = { title: s.file, file: s.file, specs: [], suites: [] }
      suites.push(fileSuite)
    }
    const target = s.describe
      ? (fileSuite.suites!.find((x) => x.title === s.describe) ??
        (fileSuite.suites!.push({ title: s.describe, file: s.file, specs: [] }),
        fileSuite.suites![fileSuite.suites!.length - 1]))
      : fileSuite
    target.specs!.push({
      title: s.title,
      file: s.file,
      tests: [{ projectName: s.project, status: s.status }],
    })
  }
  void byFile
  return { suites }
}

const passing = Array.from({ length: MIN_TESTS_PER_SHARD }, (_, i) => ({
  file: 'tests/filler.spec.ts',
  title: `filler ${i}`,
  project: 'chromium',
  status: 'expected',
}))

describe('e2e known-failure ratchet', () => {
  it('builds ids without the line number, and without the file-level suite title', () => {
    const records = collectOutcomes(
      report([
        {
          file: 'tests/a.spec.ts',
          describe: 'Group',
          title: 'does a thing',
          project: 'chromium',
          status: 'expected',
        },
      ])
    )
    expect(records).toEqual([
      { id: 'chromium | tests/a.spec.ts | Group > does a thing', outcome: 'passed' },
    ])
    expect(testId('p', 'f', ['a', 'b'])).toBe('p | f | a > b')
  })

  it('passes when every failure is on the known list', () => {
    const records = collectOutcomes(
      report([
        ...passing,
        { file: 'tests/a.spec.ts', title: 'known bad', project: 'chromium', status: 'unexpected' },
      ])
    )
    const result = ratchet(records, ['chromium | tests/a.spec.ts | known bad'])
    expect(result.ok).toBe(true)
    expect(result.stillFailing).toEqual(['chromium | tests/a.spec.ts | known bad'])
  })

  it('fails on a failure that is NOT on the known list', () => {
    const records = collectOutcomes(
      report([
        ...passing,
        {
          file: 'tests/a.spec.ts',
          title: 'brand new bad',
          project: 'chromium',
          status: 'unexpected',
        },
      ])
    )
    const result = ratchet(records, [])
    expect(result.ok).toBe(false)
    expect(result.newFailures).toEqual(['chromium | tests/a.spec.ts | brand new bad'])
  })

  it('fails when a known failure starts passing, so the list cannot rot', () => {
    const records = collectOutcomes(
      report([
        ...passing,
        { file: 'tests/a.spec.ts', title: 'fixed now', project: 'chromium', status: 'expected' },
      ])
    )
    const result = ratchet(records, ['chromium | tests/a.spec.ts | fixed now'])
    expect(result.ok).toBe(false)
    expect(result.nowPassing).toEqual(['chromium | tests/a.spec.ts | fixed now'])
  })

  it('does not let a skipped or flaky run retire a known failure', () => {
    for (const status of ['skipped', 'flaky']) {
      const records = collectOutcomes(
        report([
          ...passing,
          { file: 'tests/a.spec.ts', title: 'known bad', project: 'chromium', status },
        ])
      )
      const result = ratchet(records, ['chromium | tests/a.spec.ts | known bad'])
      expect(result.nowPassing, `status=${status}`).toEqual([])
      expect(result.ok, `status=${status}`).toBe(true)
    }
  })

  it('treats the same title in two projects as two distinct tests', () => {
    const records = collectOutcomes(
      report([
        ...passing,
        { file: 'tests/a.spec.ts', title: 'shared', project: 'chromium', status: 'unexpected' },
        {
          file: 'tests/a.spec.ts',
          title: 'shared',
          project: 'chromium-public',
          status: 'unexpected',
        },
      ])
    )
    const result = ratchet(records, ['chromium | tests/a.spec.ts | shared'])
    expect(result.newFailures).toEqual(['chromium-public | tests/a.spec.ts | shared'])
  })

  // --- fail-closed behaviour -------------------------------------------------

  it('fails a shard that reported zero tests', () => {
    const result = ratchet([], [])
    expect(result.ok).toBe(false)
    expect(result.fatal.join(' ')).toContain('zero tests')
  })

  it('fails a truncated shard even though it shows no failures', () => {
    // The crash case: the tests that never ran are ABSENT, not failed, so
    // without the floor this is indistinguishable from a clean shard.
    const records = collectOutcomes(
      report([
        {
          file: 'tests/a.spec.ts',
          title: 'ran before the crash',
          project: 'chromium',
          status: 'expected',
        },
      ])
    )
    expect(records.every((r) => r.outcome === 'passed')).toBe(true)
    const result = ratchet(records, [])
    expect(result.ok).toBe(false)
    expect(result.fatal.join(' ')).toContain('floor')
  })

  it('fails when Playwright reported a global error outside any test', () => {
    const records = collectOutcomes(report(passing))
    expect(ratchet(records, []).ok).toBe(true)
    const result = ratchet(records, [], { globalErrors: 1 })
    expect(result.ok).toBe(false)
    expect(result.fatal.join(' ')).toContain('global error')
  })

  // --- the committed baseline ------------------------------------------------

  it('ships a baseline that is well formed, sorted and free of duplicates', () => {
    const file = path.resolve(__dirname, '../../e2e/known-failures.json')
    const baseline = JSON.parse(readFileSync(file, 'utf8')) as { tests: string[] }
    expect(Array.isArray(baseline.tests)).toBe(true)
    expect(baseline.tests.length).toBeGreaterThan(0)
    expect(new Set(baseline.tests).size).toBe(baseline.tests.length)
    expect([...baseline.tests].sort()).toEqual(baseline.tests)
    for (const id of baseline.tests) {
      // `project | file | title` -- three parts, and a real spec file.
      const parts = id.split(' | ')
      expect(parts, id).toHaveLength(3)
      expect(parts[1], id).toMatch(/^tests\/.+\.spec\.ts$/)
      expect(parts[2].length, id).toBeGreaterThan(0)
    }
  })
})
