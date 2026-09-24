#!/usr/bin/env bun
/**
 * REQ-21: the upstream intake ledger must match this branch's history.
 *
 * Fails when
 * - a commit in history carries `(cherry picked from commit X)` and no ledger
 *   entry has `upstream_sha` X;
 * - a commit carries that trailer, but no cherry-pick entry for X both names
 *   that commit as its `downstream_commit` and records the decision `accepted`;
 * - an entry's `downstream_commit` is in history but carries no trailer for
 *   the entry's `upstream_sha`;
 * - an entry records only one of `downstream_commit` and `patch_id`;
 * - a ledger entry names a fork commit (`downstream_head`, `merge_base`,
 *   `downstream_commit`) that is not in history;
 * - a ledger entry's `patch_id` does not match its `downstream_commit`;
 * - a commit message names a commit in a cherry-pick reference that is not a
 *   trailer line the check can read, or `git log` prints a record that does
 *   not start with a commit id (see `parseCherryPicks`);
 * - a merge intake is wrong or incomplete (see `findMergeIntakeViolations`):
 *   a merge commit brings upstream history into this branch and no record
 *   names it, an upstream commit that merge brought in has no record, or a
 *   merge record does not hold against the merge it names.
 *
 * A merge intake record (`intake: "merge"`) covers one upstream commit that a
 * merge commit brought in: `downstream_commit` is that merge, `downstream_head`
 * is its fork-side parent, and `merge_base` is a merge base of
 * `downstream_head` and `upstream_sha`. It records no `patch_id` and needs no
 * cherry-pick trailer. A merged commit cannot be `deferred`; a `rejected` one
 * names the later fork commit that undoes it as `neutralized_by`.
 *
 * The ledger path comes from `.venturi/repository-governance.json`
 * (`authority.upstream.ledger`). Needs full history: CI checks out with
 * `fetch-depth: 0`, and a shallow clone is refused rather than half-checked.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const FULL_SHA = /^[0-9a-f]{40}$/
const MARKER = '(cherry picked from commit'
/** A trailer line as `git cherry-pick -x` writes it, optionally indented. */
const TRAILER = /^[ \t]*\(cherry picked from commit ([0-9a-f]{7,40})\)[ \t\r]*$/gm
/** The trailer text followed by a hex digit in any case: a reference to a commit. */
const REFERENCE = /\(cherry picked from commit[ \t]*[0-9a-f]/gi
const FORK_SHA_FIELDS = ['downstream_head', 'merge_base', 'downstream_commit'] as const
const DECISIONS = ['accepted', 'rejected', 'deferred'] as const

/**
 * The upstream QuackbackIO/quackback commit this fork branched from: upstream
 * #284, "Unified authentication: a single sign-in surface for portal and
 * admin" (2026-06-25). Every commit it reaches is upstream history, so a merge
 * whose merge base is one of them brought upstream history into the fork.
 */
export const FORK_POINT = '9b2d28c53f7461d5ed0a4e7ad1b8745b82fe1b16'

/**
 * Config that `git()` pins with `-c` on every command it runs. Both keys change
 * `git show` output and have no command-line flag: `core.quotePath=false`
 * prints a non-ASCII path unquoted in the `diff --git`, `---` and `+++` lines,
 * and `diff.suppressBlankEmpty=true` drops the space from blank context lines.
 */
export const GIT_CONFIG_PINS = ['-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=false']

/**
 * The `git show` arguments that print a commit's diff for
 * `git patch-id --stable`, run with `GIT_CONFIG_PINS` and without the
 * `GIT_DIFF_OPTS` environment variable (see `PATCH_ID_COMMAND`).
 *
 * The id is then independent of the working directory and of these settings,
 * wherever they are set (system, global, repository or worktree config, `-c`,
 * or `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT`):
 * - `diff.relative`, which in a subdirectory limits the diff to that
 *   subdirectory and shortens its paths (`--no-relative`);
 * - `diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix` and
 *   `diff.dstPrefix` (`--src-prefix`, `--dst-prefix`);
 * - `diff.context` and `diff.interHunkContext` (`--unified`,
 *   `--inter-hunk-context`);
 * - `diff.algorithm`, `diff.<driver>.algorithm` and `diff.indentHeuristic`
 *   (`--diff-algorithm`, `--indent-heuristic`). The algorithm alone changes
 *   the id of f22b51b26 (histogram 0a6cd43f..., myers 5075068b...);
 * - `diff.renames` (`--no-renames`), `diff.external` and the
 *   `GIT_EXTERNAL_DIFF` environment variable (`--no-ext-diff`), and
 *   `diff.<driver>.textconv` (`--no-textconv`);
 * - binary detection by `core.bigFileThreshold`, `diff.<driver>.binary` and
 *   the `diff` and `binary` attributes, including those from
 *   `core.attributesFile` and `.git/info/attributes` (`--text`);
 * - `diff.submodule` and `diff.ignoreSubmodules` (`--submodule=short`,
 *   `--ignore-submodules=none`);
 * - `color.ui` and `color.diff` (`--no-color`), and `log.showSignature`
 *   (`--no-show-signature`), whose output comes before the diff;
 * - `core.quotePath` and `diff.suppressBlankEmpty` (`GIT_CONFIG_PINS`).
 * `GIT_DIFF_OPTS` overrides `--unified`, so `git()` removes it from the
 * environment. `git patch-id --stable` ignores `patchid.stable` and
 * `patchid.verbatim`, and sums per-file hashes, so the file order
 * (`diff.orderFile`) does not matter. This list makes no claim about any
 * setting it does not name. Replace refs (`git replace`) are not pinned: a
 * replaced commit shows its replacement's diff.
 */
export const PATCH_ID_SHOW_ARGS = [
  'show',
  '--no-color',
  '--no-ext-diff',
  '--no-relative',
  '--no-renames',
  '--no-textconv',
  '--text',
  '--ignore-submodules=none',
  '--submodule=short',
  '--no-show-signature',
  '--diff-algorithm=histogram',
  '--indent-heuristic',
  '--unified=3',
  '--inter-hunk-context=0',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--format=',
]

/** The patch-id command as documented for ledger authors. */
export const PATCH_ID_COMMAND = `env -u GIT_DIFF_OPTS git ${[...GIT_CONFIG_PINS, ...PATCH_ID_SHOW_ARGS].join(' ')} <sha> | git patch-id --stable`

/**
 * The `git log` arguments that print, as `%H%x00%B%x1e` records, every commit
 * in `HEAD`'s history whose message contains `(cherry picked from commit` in
 * any case, whatever follows it. `--no-show-signature` keeps
 * `log.showSignature` from printing verification lines in front of each
 * record.
 */
export const CHERRY_PICK_LOG_ARGS = [
  'log',
  '--no-show-signature',
  '--format=%H%x00%B%x1e',
  '--fixed-strings',
  '--regexp-ignore-case',
  `--grep=${MARKER}`,
  'HEAD',
]

export interface LedgerEntry {
  upstream_sha: string
  merge_base: string
  downstream_head: string
  downstream_commit?: string
  patch_id?: string
  /** Present only on a merge intake record; absent means a cherry-pick. */
  intake?: 'merge'
  /** On a rejected merge intake record: the fork commit that undoes the upstream change. */
  neutralized_by?: string
  review: { decision: (typeof DECISIONS)[number] }
}

export interface CherryPick {
  commit: string
  upstream: string
}

export interface CherryPickLog {
  picks: CherryPick[]
  problems: string[]
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
    for (const field of ['downstream_commit', 'patch_id', 'neutralized_by']) {
      if (record[field] === undefined) continue
      if (typeof record[field] !== 'string' || !FULL_SHA.test(record[field] as string)) {
        throw new Error(`ledger line ${index + 1}: ${field} must be a lowercase 40-character SHA`)
      }
    }
    if (record.intake !== undefined && record.intake !== 'merge') {
      throw new Error(`ledger line ${index + 1}: intake must be "merge" when present`)
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

/**
 * Parses `git log` output in the `CHERRY_PICK_LOG_ARGS` format. A trailer is a
 * line of its own, optionally indented, holding a lowercase 7- to
 * 40-character id after one space. Every other mention of the trailer text
 * followed by spaces or tabs, or nothing, and then a hex digit (an uppercase
 * id, a tab or no space before the id, text after the closing parenthesis, a
 * quote or list marker in front, a short id) is reported, because the check
 * cannot tell which upstream commit it names. A mention followed by a placeholder such as
 * `X` or `<sha>` is prose and is not reported. A record that does not start
 * with a full commit id, such as signature output, is reported too.
 */
export function parseCherryPicks(log: string): CherryPickLog {
  const picks: CherryPick[] = []
  const problems: string[] = []
  for (const record of log.split('\x1e')) {
    const text = record.trim()
    if (!text) continue
    const separator = text.indexOf('\x00')
    const commit = separator === -1 ? text : text.slice(0, separator)
    if (!FULL_SHA.test(commit)) {
      problems.push(
        `git log printed a record that does not start with a commit id: ${JSON.stringify(text.slice(0, 80))}`
      )
      continue
    }
    const body = separator === -1 ? '' : text.slice(separator + 1)
    const trailers = [...body.matchAll(TRAILER)].map((match) => match[1])
    for (const upstream of trailers) picks.push({ commit, upstream })
    const unreadable = (body.match(REFERENCE)?.length ?? 0) - trailers.length
    if (unreadable > 0) {
      problems.push(
        `${commit}: ${unreadable} cherry-pick reference(s) in its message are not a trailer line "${MARKER} <sha>)" with a lowercase 7- to 40-character sha`
      )
    }
  }
  return { picks, problems }
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
      // A merge intake record never satisfies a pick: its patch-id is not checked.
      !recorded.some(
        (entry) =>
          entry.intake !== 'merge' &&
          entry.downstream_commit === pick.commit &&
          entry.review.decision === 'accepted'
      )
    ) {
      problems.push(
        `${pick.commit} was cherry-picked from upstream ${pick.upstream}, but no accepted ledger entry for it has downstream_commit ${pick.commit}`
      )
    }
  }
  entries.forEach((entry, index) => {
    const label = `ledger entry ${index + 1} (upstream ${entry.upstream_sha})`
    const merge = entry.intake === 'merge'
    if (merge) {
      // The merge itself is checked by findMergeIntakeViolations.
      if (entry.downstream_commit === undefined) {
        problems.push(`${label}: a merge intake names its merge commit as downstream_commit`)
      }
      if (entry.patch_id !== undefined) {
        problems.push(`${label}: a merge intake records no patch_id`)
      }
    } else {
      if ((entry.downstream_commit === undefined) !== (entry.patch_id === undefined)) {
        problems.push(`${label}: downstream_commit and patch_id must be recorded together`)
      }
      if (entry.neutralized_by !== undefined) {
        problems.push(`${label}: neutralized_by belongs only on a merge intake record`)
      }
    }
    for (const field of FORK_SHA_FIELDS) {
      const sha = entry[field]
      if (sha !== undefined && !history.inHistory(sha)) {
        problems.push(`${label}: ${field} ${sha} is not in this branch's history`)
      }
    }
    if (entry.neutralized_by !== undefined && !history.inHistory(entry.neutralized_by)) {
      problems.push(
        `${label}: neutralized_by ${entry.neutralized_by} is not in this branch's history`
      )
    }
    const commit = entry.downstream_commit
    if (merge || commit === undefined || !history.inHistory(commit)) return
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

/** What `findMergeIntakeViolations` reads from history. */
export interface MergeHistory {
  /** Whether the checked branch reaches `sha`. */
  inHistory(sha: string): boolean
  /** Whether `ancestor` is `descendant` or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean
  /** The parents of `sha`, first parent first. */
  parents(sha: string): string[]
  /** Every merge commit the checked branch reaches and `excluded` does not, with its parents. */
  merges(excluded: string[]): Array<{ commit: string; parents: string[] }>
  /** Every commit `tips` reach, the tips included. */
  reachable(tips: string[]): Set<string>
  /** Every merge base of `a` and `b`; none for unrelated histories. */
  mergeBases(a: string, b: string): string[]
  /** The commits `include` reaches and `exclude` does not. */
  between(include: string[], exclude: string[]): string[]
}

/**
 * Checks merge intakes, which carry no cherry-pick trailer.
 *
 * Upstream history is what `forkPoint` and the recorded merge intakes'
 * `upstream_sha` reach. A merge in `HEAD`'s history that is not itself upstream
 * history brought upstream history in when one of its merge bases is upstream
 * history: a fork branch always forks from a fork commit, so its merge base
 * with the fork is a fork commit. Such a merge must be named by merge intake
 * records, one for every commit it brought in (the commits its other parents
 * reach and its fork-side parent does not), and each record must hold against
 * the merge it names. An intake that no record names yet is found through the
 * fork point, and a later intake on top of a recorded one through that
 * record's `upstream_sha`.
 */
export function findMergeIntakeViolations(
  entries: LedgerEntry[],
  history: MergeHistory,
  forkPoint: string = FORK_POINT
): string[] {
  const problems: string[] = []
  const records = entries
    .map((entry, index) => ({
      entry,
      label: `ledger entry ${index + 1} (upstream ${entry.upstream_sha})`,
    }))
    .filter(({ entry }) => entry.intake === 'merge' && entry.downstream_commit !== undefined)

  for (const { entry, label } of records) {
    const merge = entry.downstream_commit!
    // A merge commit outside history is reported by findLedgerViolations.
    if (!history.inHistory(merge)) continue
    const parents = history.parents(merge)
    if (parents.length < 2) {
      problems.push(`${label}: downstream_commit ${merge} is not a merge commit`)
      continue
    }
    if (!parents.includes(entry.downstream_head)) {
      problems.push(
        `${label}: downstream_head ${entry.downstream_head} is not a parent of merge ${merge}`
      )
      continue
    }
    const incoming = parents.filter((parent) => parent !== entry.downstream_head)
    if (!history.between(incoming, [entry.downstream_head]).includes(entry.upstream_sha)) {
      problems.push(`${label}: merge ${merge} did not bring in ${entry.upstream_sha}`)
    } else if (
      !history.mergeBases(entry.downstream_head, entry.upstream_sha).includes(entry.merge_base)
    ) {
      problems.push(
        `${label}: merge_base ${entry.merge_base} is not a merge base of ${entry.downstream_head} and ${entry.upstream_sha}`
      )
    }
    const decision = entry.review.decision
    const neutralizedBy = entry.neutralized_by
    if (decision === 'deferred') {
      problems.push(
        `${label}: a merged upstream commit cannot be deferred; record it accepted, or rejected with neutralized_by`
      )
    } else if (decision === 'rejected' && neutralizedBy === undefined) {
      problems.push(
        `${label}: a rejected merged commit names the fork commit that undoes it as neutralized_by`
      )
    } else if (decision === 'accepted' && neutralizedBy !== undefined) {
      problems.push(`${label}: neutralized_by belongs only on a rejected record`)
    }
    if (
      neutralizedBy !== undefined &&
      history.inHistory(neutralizedBy) &&
      (neutralizedBy === merge || !history.isAncestor(merge, neutralizedBy))
    ) {
      problems.push(`${label}: neutralized_by ${neutralizedBy} does not come after merge ${merge}`)
    }
  }

  const recordedUpstream = records
    .map(({ entry }) => entry.upstream_sha)
    .filter((sha) => history.inHistory(sha))
  const upstream = history.reachable([forkPoint, ...new Set(recordedUpstream)])
  for (const { commit, parents } of history.merges([forkPoint])) {
    if (upstream.has(commit)) continue // a merge inside upstream history
    const [first, ...others] = parents
    const upstreamBase = others
      .flatMap((parent) => history.mergeBases(first!, parent))
      .find((base) => upstream.has(base))
    if (upstreamBase === undefined) continue // a fork branch
    const named = records.filter(({ entry }) => entry.downstream_commit === commit)
    if (named.length === 0) {
      problems.push(
        `merge ${commit} brings upstream history into this branch (merge base ${upstreamBase}), but no merge intake record names it as downstream_commit`
      )
      continue
    }
    const heads = [...new Set(named.map(({ entry }) => entry.downstream_head))]
    if (heads.length > 1) {
      problems.push(`merge ${commit}: its records name more than one fork-side parent`)
      continue
    }
    const head = heads[0]!
    // A head that is not a parent is reported per record above.
    if (!parents.includes(head)) continue
    const covered = new Set(named.map(({ entry }) => entry.upstream_sha))
    const brought = history.between(
      parents.filter((parent) => parent !== head),
      [head]
    )
    for (const sha of brought) {
      if (!covered.has(sha)) {
        problems.push(
          `merge ${commit} brought in upstream commit ${sha}, which has no merge intake record naming ${commit}`
        )
      }
    }
  }
  return problems
}

/**
 * Runs git with `GIT_CONFIG_PINS` and without `GIT_DIFF_OPTS`, which would
 * override `--unified`. Returns the output as bytes.
 */
function gitBytes(args: string[], input?: Buffer, cwd?: string): Buffer {
  const env = { ...process.env }
  delete env.GIT_DIFF_OPTS
  return execFileSync('git', [...GIT_CONFIG_PINS, ...args], {
    cwd,
    env,
    input,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  })
}

function git(args: string[], input?: Buffer, cwd?: string): string {
  return gitBytes(args, input, cwd).toString('utf8')
}

/** The pinned patch-id of `sha` in the repository at `cwd` (default: the working directory). */
export function patchIdOf(sha: string, cwd?: string): string {
  // The diff goes to `git patch-id` as bytes, as in the documented pipeline.
  // Decoding it as UTF-8 first would replace any byte of a file that is not
  // UTF-8, and so change the id.
  const diff = gitBytes([...PATCH_ID_SHOW_ARGS, sha], undefined, cwd)
  return git(['patch-id', '--stable'], diff, cwd).split(' ')[0] ?? ''
}

/** The cherry-pick trailers in `HEAD`'s history at `cwd` (default: the working directory). */
export function readCherryPicks(cwd?: string): CherryPickLog {
  return parseCherryPicks(git(CHERRY_PICK_LOG_ARGS, undefined, cwd))
}

const gitHistory: HistoryProbe = {
  inHistory: (sha) =>
    spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' }).status ===
    0,
  patchId: (sha) => patchIdOf(sha),
}

/**
 * `MergeHistory` of `head` in the repository at `cwd` (default: `HEAD` in the
 * working directory).
 */
export function gitMergeHistory(cwd?: string, head = 'HEAD'): MergeHistory {
  const lines = (args: string[]) =>
    git(args, undefined, cwd)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  const revList = (include: string[], exclude: string[], flags: string[] = []) =>
    lines(['rev-list', ...flags, ...include, '--not', ...exclude, '--'])
  const isAncestor = (ancestor: string, descendant: string) =>
    spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      stdio: 'ignore',
    }).status === 0
  return {
    inHistory: (sha) => isAncestor(sha, head),
    isAncestor,
    parents: (sha) =>
      lines(['rev-list', '--parents', '-n', '1', sha, '--'])[0]!.split(' ').slice(1),
    merges: (excluded) =>
      revList([head], excluded, ['--merges', '--parents']).map((line) => {
        const [commit, ...parents] = line.split(' ')
        return { commit: commit!, parents }
      }),
    reachable: (tips) => new Set(lines(['rev-list', ...tips, '--'])),
    mergeBases: (a, b) => {
      // Exit status 1 with no output means the histories share no commit.
      const result = spawnSync('git', ['merge-base', '--all', a, b], { cwd, encoding: 'utf8' })
      if (result.status !== 0) return []
      return result.stdout.split('\n').filter(Boolean)
    },
    between: (include, exclude) => revList(include, exclude),
  }
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
  if (!gitHistory.inHistory(FORK_POINT)) {
    console.error(`The upstream fork point ${FORK_POINT} is not in this branch's history.`)
    process.exit(1)
  }
  const entries = parseLedger(readFileSync(ledgerPath, 'utf8'))
  const { picks, problems: logProblems } = readCherryPicks()
  const problems = [
    ...logProblems,
    ...findLedgerViolations(entries, picks, gitHistory),
    ...findMergeIntakeViolations(entries, gitMergeHistory()),
  ]
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  const merges = new Set(
    entries.filter((entry) => entry.intake === 'merge').map((entry) => entry.downstream_commit)
  )
  console.log(
    `${ledgerPath}: ${entries.length} entries, ${picks.length} cherry-picked commits, ${merges.size} merge intake(s).`
  )
}
