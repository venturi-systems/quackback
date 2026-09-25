/**
 * One-line progress markers for the database CLI scripts (migrate.ts, seed.ts).
 *
 * HYG-31 (landing-page#2309): CI setup steps that ran these scripts hung and
 * printed nothing, until a step cap killed them. The log could not say whether
 * the process had started, was still loading modules, or was waiting on the
 * database. Import this module FIRST in a script: ES modules evaluate in import
 * order, so its line is written before the heavier imports load. Each later
 * phase() call names the step the script is about to take, so the last line
 * of a hung run names the step that hung.
 *
 * Written to stderr with a synchronous write, so each line is on the pipe
 * before the next step starts and survives a process killed while it hangs.
 * The time is milliseconds since the process started.
 */
import { writeSync } from 'node:fs'
import { basename } from 'node:path'

const script = basename(process.argv[1] ?? 'script')

export function phase(label: string): void {
  try {
    writeSync(2, `[${script} +${Math.round(performance.now())}ms] ${label}\n`)
  } catch {
    // stderr is closed: there is nowhere to report progress to.
  }
}

phase(`started on bun ${process.versions.bun ?? 'unknown'}; loading modules`)
