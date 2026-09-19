#!/usr/bin/env bun
/**
 * CLI wrapper around the e2e ratchet. Run after the Playwright shard:
 *
 *   bun e2e/scripts/check-known-failures.ts e2e-results.json e2e/known-failures.json e2e-plan.json
 *
 * Exit code is the gate -- Playwright's own exit code is deliberately NOT the
 * gate, because a known failure must not redden the lane while it is on the
 * list. Everything else still does, including the suite failing to produce a
 * report at all.
 */
import { existsSync, readFileSync } from 'node:fs'
import { collectOutcomes, formatReport, ratchet, type JsonReport } from './known-failures'

const [reportPath, baselinePath, planPath] = process.argv.slice(2)

if (!reportPath || !baselinePath || !planPath) {
  console.error('usage: check-known-failures.ts <playwright-json-report> <known-failures.json> <shard-plan.json>')
  process.exit(2)
}

if (!existsSync(reportPath)) {
  console.error(
    `FATAL: no Playwright JSON report at ${reportPath}.\n` +
      'The suite did not get far enough to write one -- treating that as a failure, ' +
      'not as "nothing failed".'
  )
  process.exit(1)
}

let report: JsonReport
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8')) as JsonReport
} catch (error) {
  console.error(`FATAL: ${reportPath} is not valid JSON: ${(error as Error).message}`)
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
  tests: string[]
}

let plan: JsonReport
try {
  plan = JSON.parse(readFileSync(planPath, 'utf8')) as JsonReport
  if (!Array.isArray(plan.suites) || (plan.errors?.length ?? 0) > 0) {
    throw new Error('the shard plan must contain suites and no global errors')
  }
} catch (error) {
  console.error(`FATAL: cannot read the shard plan at ${planPath}: ${(error as Error).message}`)
  process.exit(1)
}

const result = ratchet(collectOutcomes(report), baseline.tests ?? [], {
  globalErrors: report.errors?.length ?? 0,
  expectedIds: collectOutcomes(plan).map(({ id }) => id),
})
console.log(formatReport(result))
process.exit(result.ok ? 0 : 1)
