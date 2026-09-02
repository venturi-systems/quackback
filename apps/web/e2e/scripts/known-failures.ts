/**
 * Ratchet gate for the end-to-end lane.
 *
 * The Playwright suite was never wired into CI before this lane existed, so it
 * accumulated failures nobody was told about. Enrolling it honestly means the
 * lane has to run and has to be believed -- but it cannot be blocking on day
 * one without stopping every merge in the repository.
 *
 * So the lane is gated on a ratchet instead of on green:
 *
 *   - a failure NOT in `known-failures.json` fails the shard immediately;
 *   - a test that IS in `known-failures.json` and passed fails the shard too,
 *     demanding the entry be deleted. The list can only shrink.
 *
 * A one-directional list would rot back into a rubber stamp: entries would sit
 * there long after the tests were fixed and would silently re-absorb the next
 * regression in the same test. Both directions are enforced for that reason.
 *
 * The gate also fails closed. A missing report, an unparseable one, or a shard
 * that reported zero tests is a failure -- never a pass. Those are exactly the
 * shapes a crashed web server or a bad shard index produces, and treating them
 * as "nothing failed" is the false-green this whole lane exists to prevent.
 */

export type TestOutcome = 'passed' | 'failed' | 'skipped' | 'flaky'

export interface TestRecord {
  id: string
  outcome: TestOutcome
}

interface JsonSpec {
  title?: string
  file?: string
  tests?: Array<{ projectName?: string; status?: string }>
}

interface JsonSuite {
  title?: string
  file?: string
  specs?: JsonSpec[]
  suites?: JsonSuite[]
}

export interface JsonReport {
  suites?: JsonSuite[]
  /** Global (non-test) errors: a webServer that never came up, a config throw. */
  errors?: unknown[]
  stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number }
}

/**
 * Stable identity for one test: `project | file | describe > ... > title`.
 *
 * Deliberately excludes the line number that Playwright's console reporter
 * prints. Line numbers move every time anything above a test is edited, which
 * would churn the baseline on unrelated changes and quietly turn a known
 * failure into a "new" one.
 */
export function testId(project: string, file: string, titlePath: string[]): string {
  return `${project} | ${file} | ${titlePath.join(' > ')}`
}

/** Playwright's per-test `status` vocabulary, mapped onto ours. */
function toOutcome(status: string | undefined): TestOutcome {
  switch (status) {
    case 'expected':
      return 'passed'
    case 'unexpected':
      return 'failed'
    case 'flaky':
      return 'flaky'
    default:
      return 'skipped'
  }
}

/** Flatten a Playwright JSON report into one record per (test, project). */
export function collectOutcomes(report: JsonReport): TestRecord[] {
  const records: TestRecord[] = []

  const walk = (suite: JsonSuite, titlePath: string[]): void => {
    // The outermost suite of a file is titled with the file path itself; it is
    // not a `describe` and must not appear in the id.
    const isFileSuite = suite.title !== undefined && suite.title === suite.file
    const nextPath = isFileSuite || !suite.title ? titlePath : [...titlePath, suite.title]

    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        records.push({
          id: testId(test.projectName ?? '', spec.file ?? suite.file ?? '', [
            ...nextPath,
            spec.title ?? '',
          ]),
          outcome: toOutcome(test.status),
        })
      }
    }
    for (const child of suite.suites ?? []) walk(child, nextPath)
  }

  for (const suite of report.suites ?? []) walk(suite, [])
  return records
}

export interface RatchetResult {
  ok: boolean
  /** Failed, and not on the known list. Blocks the shard. */
  newFailures: string[]
  /** On the known list and passed. Blocks the shard: delete the entry. */
  nowPassing: string[]
  /** On the known list and failed. Tolerated; reported for visibility. */
  stillFailing: string[]
  /** Non-test problems -- no report, zero tests. Blocks the shard. */
  fatal: string[]
}

/**
 * Smallest believable number of tests in a shard. The eight shards carried
 * 46-179 tests each when this lane was introduced, so a shard reporting fewer
 * than this did not run -- it died partway and wrote a truncated report.
 *
 * This floor is the guard against the one false-green this design would
 * otherwise still have: a run that crashes mid-suite writes a report in which
 * the tests that never ran are simply ABSENT, not failed, and absent tests
 * produce no new failures. Without a floor that reads as "nothing broke".
 */
export const MIN_TESTS_PER_SHARD = 10

export function ratchet(
  records: TestRecord[],
  baseline: readonly string[],
  options: { globalErrors?: number; minTests?: number } = {}
): RatchetResult {
  const known = new Set(baseline)
  const minTests = options.minTests ?? MIN_TESTS_PER_SHARD
  const newFailures: string[] = []
  const nowPassing: string[] = []
  const stillFailing: string[] = []
  const fatal: string[] = []

  if (records.length === 0) {
    fatal.push(
      'The shard reported zero tests. That is a crashed web server or a bad shard index, ' +
        'not a clean run -- failing closed.'
    )
  } else if (records.length < minTests) {
    fatal.push(
      `The shard reported only ${records.length} tests (floor ${minTests}). A run that dies ` +
        'partway writes a report where the remaining tests are absent rather than failed, ' +
        'which would otherwise look like a clean shard.'
    )
  }

  if (options.globalErrors) {
    fatal.push(
      `Playwright reported ${options.globalErrors} global error(s) outside any test ` +
        '(typically the web server never came up). The shard result cannot be trusted.'
    )
  }

  for (const { id, outcome } of records) {
    if (outcome === 'failed') {
      if (known.has(id)) stillFailing.push(id)
      else newFailures.push(id)
    } else if (outcome === 'passed' && known.has(id)) {
      nowPassing.push(id)
    }
    // `flaky` passed on retry, and `skipped` never ran: neither proves a known
    // failure is fixed, so neither may retire a baseline entry.
  }

  return {
    ok: fatal.length === 0 && newFailures.length === 0 && nowPassing.length === 0,
    newFailures: newFailures.sort(),
    nowPassing: nowPassing.sort(),
    stillFailing: stillFailing.sort(),
    fatal,
  }
}

export function formatReport(result: RatchetResult): string {
  const lines: string[] = []
  for (const message of result.fatal) lines.push(`FATAL: ${message}`)
  if (result.newFailures.length > 0) {
    lines.push(`${result.newFailures.length} NEW failure(s) -- not on the known-failure list:`)
    for (const id of result.newFailures) lines.push(`  + ${id}`)
    lines.push('')
    lines.push('Fix these. Do not add them to e2e/known-failures.json: that list only shrinks.')
  }
  if (result.nowPassing.length > 0) {
    lines.push(`${result.nowPassing.length} known failure(s) now PASS. Delete them from`)
    lines.push('e2e/known-failures.json so the ratchet keeps holding them:')
    for (const id of result.nowPassing) lines.push(`  - ${id}`)
  }
  if (result.stillFailing.length > 0) {
    lines.push(`${result.stillFailing.length} known failure(s) still failing (tolerated).`)
  }
  if (result.ok) lines.push('E2E ratchet: OK.')
  return lines.join('\n')
}
