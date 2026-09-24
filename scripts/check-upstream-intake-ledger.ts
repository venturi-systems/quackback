#!/usr/bin/env bun
/**
 * REQ-21: the upstream intake ledger must match this branch's history.
 *
 * Fails when
 * - a commit in history carries `(cherry picked from commit X)` and no ledger
 *   entry has `upstream_sha` X;
 * - a ledger entry names a fork commit (`downstream_head`, `merge_base`,
 *   `downstream_commit`) that is not in history;
 * - a ledger entry's `patch_id` does not match its `downstream_commit`.
 *
 * The ledger path comes from `.venturi/repository-governance.json`
 * (`authority.upstream.ledger`). Needs full history: CI checks out with
 * `fetch-depth: 0`, and a shallow clone is refused rather than half-checked.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const FULL_SHA = /^[0-9a-f]{40}$/
const TRAILER = /^\(cherry picked from commit ([0-9a-f]{7,40})\)[ \t\r]*$/gm
const FORK_SHA_FIELDS = ['downstream_head', 'merge_base', 'downstream_commit'] as const

/** Pinned so the patch-id does not depend on the caller's git config. */
export const PATCH_ID_SHOW_ARGS = [
  'show',
  '--no-color',
  '--no-ext-diff',
  '--no-renames',
  '--diff-algorithm=histogram',
  '--format=',
]

export interface LedgerEntry {
  upstream_sha: string
  merge_base: string
  downstream_head: string
  downstream_commit?: string
  patch_id?: string
}

export interface CherryPick {
  commit: string
  upstream: string
}

export interface HistoryProbe {
  inHistory(sha: string): boolean
  patchId(sha: string): string
}

export function parseLedger(text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return
    let record: Record<string, unknown> | null
    try {
      record = JSON.parse(line)
    } catch {
      throw new Error(`ledger line ${index + 1} is not valid JSON`)
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new Error(`ledger line ${index + 1} is not a JSON object`)
    }
    for (const field of ['upstream_sha', 'merge_base', 'downstream_head']) {
      if (typeof record[field] !== 'string' || !FULL_SHA.test(record[field] as string)) {
        throw new Error(`ledger line ${index + 1}: ${field} must be a lowercase 40-character SHA`)
      }
    }
    for (const field of ['downstream_commit', 'patch_id']) {
      if (record[field] === undefined) continue
      if (typeof record[field] !== 'string' || !FULL_SHA.test(record[field] as string)) {
        throw new Error(`ledger line ${index + 1}: ${field} must be a lowercase 40-character SHA`)
      }
    }
    entries.push(record as unknown as LedgerEntry)
  })
  return entries
}

/** Parses `git log --format=%H%x00%B%x1e` output. */
export function parseCherryPicks(log: string): CherryPick[] {
  const picks: CherryPick[] = []
  for (const record of log.split('\x1e')) {
    const [commit, body = ''] = record.trim().split('\x00')
    if (!commit) continue
    for (const match of body.matchAll(TRAILER)) picks.push({ commit, upstream: match[1] })
  }
  return picks
}

export function findLedgerViolations(
  entries: LedgerEntry[],
  picks: CherryPick[],
  history: HistoryProbe
): string[] {
  const problems: string[] = []
  for (const pick of picks) {
    if (!entries.some((entry) => entry.upstream_sha.startsWith(pick.upstream))) {
      problems.push(
        `${pick.commit} was cherry-picked from upstream ${pick.upstream}, which has no ledger entry`
      )
    }
  }
  entries.forEach((entry, index) => {
    const label = `ledger entry ${index + 1} (upstream ${entry.upstream_sha})`
    for (const field of FORK_SHA_FIELDS) {
      const sha = entry[field]
      if (sha !== undefined && !history.inHistory(sha)) {
        problems.push(`${label}: ${field} ${sha} is not in this branch's history`)
      }
    }
    const commit = entry.downstream_commit
    if (entry.patch_id !== undefined && commit !== undefined && history.inHistory(commit)) {
      const actual = history.patchId(commit)
      if (actual !== entry.patch_id) {
        problems.push(`${label}: patch_id ${entry.patch_id} does not match ${commit} (${actual})`)
      }
    }
  })
  return problems
}

function git(args: string[], input?: string): string {
  return execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 })
}

const gitHistory: HistoryProbe = {
  inHistory: (sha) =>
    spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' }).status ===
    0,
  patchId: (sha) =>
    git(['patch-id', '--stable'], git([...PATCH_ID_SHOW_ARGS, sha])).split(' ')[0] ?? '',
}

if (import.meta.main) {
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
    console.error('Shallow clone: check out with fetch-depth: 0 so history can be checked.')
    process.exit(1)
  }
  const governance = JSON.parse(readFileSync('.venturi/repository-governance.json', 'utf8'))
  const ledgerPath: string = governance.authority.upstream.ledger
  if (!existsSync(ledgerPath)) {
    console.error(`${ledgerPath} is declared by the governance manifest but does not exist.`)
    process.exit(1)
  }
  const entries = parseLedger(readFileSync(ledgerPath, 'utf8'))
  const picks = parseCherryPicks(
    git([
      'log',
      'HEAD',
      '--format=%H%x00%B%x1e',
      '--fixed-strings',
      '--grep=(cherry picked from commit ',
    ])
  )
  const problems = findLedgerViolations(entries, picks, gitHistory)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  console.log(`${ledgerPath}: ${entries.length} entries, ${picks.length} cherry-picked commits.`)
}
