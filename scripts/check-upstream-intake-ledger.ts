#!/usr/bin/env bun
/**
 * REQ-21: the upstream intake ledger must match this branch's history.
 *
 * Fails when
 * - a commit in history carries `(cherry picked from commit X)` and no ledger
 *   entry has `upstream_sha` X;
 * - a commit carries that trailer, but no entry for X both names that commit
 *   as its `downstream_commit` and records the decision `accepted`;
 * - an entry's `downstream_commit` is in history but carries no trailer for
 *   the entry's `upstream_sha`;
 * - an entry records only one of `downstream_commit` and `patch_id`;
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
const DECISIONS = ['accepted', 'rejected', 'deferred'] as const

/**
 * The `git` arguments that print a commit's diff for `git patch-id --stable`.
 * These diff settings can be changed through git config, and each is pinned on
 * the command line so the id does not depend on the caller's config: the
 * prefixes (`diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix`,
 * `diff.dstPrefix`), the context (`diff.context`, `diff.interHunkContext`),
 * blank context lines (`diff.suppressBlankEmpty`, which has no command-line
 * flag, hence `-c`), the algorithm and its heuristic, renames, external diff
 * and textconv drivers, submodule format and color. The algorithm alone
 * changes the id of f22b51b26 (histogram 0a6cd43f..., myers 5075068b...).
 * `git patch-id --stable` ignores `patchid.verbatim`, so it needs no pin.
 */
export const PATCH_ID_SHOW_ARGS = [
  '-c',
  'diff.suppressBlankEmpty=false',
  'show',
  '--no-color',
  '--no-ext-diff',
  '--no-renames',
  '--no-textconv',
  '--submodule=short',
  '--diff-algorithm=histogram',
  '--indent-heuristic',
  '--unified=3',
  '--inter-hunk-context=0',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--format=',
]

/** The patch-id command as documented for ledger authors. */
export const PATCH_ID_COMMAND = `git ${PATCH_ID_SHOW_ARGS.join(' ')} <sha> | git patch-id --stable`

export interface LedgerEntry {
  upstream_sha: string
  merge_base: string
  downstream_head: string
  downstream_commit?: string
  patch_id?: string
  review: { decision: (typeof DECISIONS)[number] }
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
    const review = record.review as { decision?: unknown } | null | undefined
    if (
      typeof review !== 'object' ||
      review === null ||
      !DECISIONS.includes(review.decision as (typeof DECISIONS)[number])
    ) {
      throw new Error(
        `ledger line ${index + 1}: review.decision must be accepted, rejected or deferred`
      )
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
    const recorded = entries.filter((entry) => entry.upstream_sha.startsWith(pick.upstream))
    if (recorded.length === 0) {
      problems.push(
        `${pick.commit} was cherry-picked from upstream ${pick.upstream}, which has no ledger entry`
      )
    } else if (
      !recorded.some(
        (entry) => entry.downstream_commit === pick.commit && entry.review.decision === 'accepted'
      )
    ) {
      problems.push(
        `${pick.commit} was cherry-picked from upstream ${pick.upstream}, but no accepted ledger entry for it has downstream_commit ${pick.commit}`
      )
    }
  }
  entries.forEach((entry, index) => {
    const label = `ledger entry ${index + 1} (upstream ${entry.upstream_sha})`
    if ((entry.downstream_commit === undefined) !== (entry.patch_id === undefined)) {
      problems.push(`${label}: downstream_commit and patch_id must be recorded together`)
    }
    for (const field of FORK_SHA_FIELDS) {
      const sha = entry[field]
      if (sha !== undefined && !history.inHistory(sha)) {
        problems.push(`${label}: ${field} ${sha} is not in this branch's history`)
      }
    }
    const commit = entry.downstream_commit
    if (commit === undefined || !history.inHistory(commit)) return
    const carriesTrailer = picks.some(
      (pick) => pick.commit === commit && entry.upstream_sha.startsWith(pick.upstream)
    )
    if (!carriesTrailer) {
      problems.push(
        `${label}: downstream_commit ${commit} carries no (cherry picked from commit ${entry.upstream_sha}) trailer`
      )
    }
    if (entry.patch_id !== undefined) {
      const actual = history.patchId(commit)
      if (actual !== entry.patch_id) {
        problems.push(`${label}: patch_id ${entry.patch_id} does not match ${commit} (${actual})`)
      }
    }
  })
  return problems
}

function git(args: string[], input?: string, cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
  })
}

/** The pinned patch-id of `sha` in the repository at `cwd` (default: the working directory). */
export function patchIdOf(sha: string, cwd?: string): string {
  const diff = git([...PATCH_ID_SHOW_ARGS, sha], undefined, cwd)
  return git(['patch-id', '--stable'], diff, cwd).split(' ')[0] ?? ''
}

const gitHistory: HistoryProbe = {
  inHistory: (sha) =>
    spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' }).status ===
    0,
  patchId: (sha) => patchIdOf(sha),
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
