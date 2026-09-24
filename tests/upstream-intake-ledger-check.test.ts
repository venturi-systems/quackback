import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CHERRY_PICK_LOG_ARGS,
  findLedgerViolations,
  findMergeIntakeViolations,
  gitMergeHistory,
  parseCherryPicks,
  parseLedger,
  patchIdOf,
  PATCH_ID_COMMAND,
  readCherryPicks,
  type HistoryProbe,
  type LedgerEntry,
} from '../scripts/check-upstream-intake-ledger'
import { buildUpstreamIntakeRecord } from '../scripts/upstream-intake-ledger'

const UPSTREAM = '1'.repeat(40)
const OTHER_UPSTREAM = '2'.repeat(40)
const FORK_PICK = '3'.repeat(40)
const FORK_PARENT = '4'.repeat(40)
const MERGE_BASE = '5'.repeat(40)
const PATCH_ID = '6'.repeat(40)

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    upstream_sha: UPSTREAM,
    merge_base: MERGE_BASE,
    downstream_head: FORK_PARENT,
    downstream_commit: FORK_PICK,
    patch_id: PATCH_ID,
    review: { decision: 'accepted' },
    ...overrides,
  }
}

function history(known: string[], patchIds: Record<string, string> = {}): HistoryProbe {
  return {
    inHistory: (sha) => known.includes(sha),
    patchId: (sha) => patchIds[sha] ?? '0'.repeat(40),
  }
}

const FULL_HISTORY = history([FORK_PICK, FORK_PARENT, MERGE_BASE], { [FORK_PICK]: PATCH_ID })

describe('REQ-21 upstream intake ledger check', () => {
  it('reads cherry-pick trailers from git log records', () => {
    const log = [
      `${FORK_PICK}\x00fix: a pick\n\n(cherry picked from commit ${UPSTREAM})\n\nClaude-Session: x\n`,
      `${FORK_PARENT}\x00chore: fork-only change\n`,
      `${MERGE_BASE}\x00fix: two picks squashed\n\n(cherry picked from commit ${UPSTREAM})\n(cherry picked from commit ${OTHER_UPSTREAM})\n`,
    ].join('\x1e\n')

    expect(parseCherryPicks(log)).toEqual({
      picks: [
        { commit: FORK_PICK, upstream: UPSTREAM },
        { commit: MERGE_BASE, upstream: UPSTREAM },
        { commit: MERGE_BASE, upstream: OTHER_UPSTREAM },
      ],
      problems: [],
    })
  })

  it('reads an indented trailer, so an unrecorded indented pick fails the check', () => {
    const log = [
      `${FORK_PICK}\x00chore: squashed intake\n\n    (cherry picked from commit ${UPSTREAM})\n`,
      `${FORK_PARENT}\x00chore: squashed intake\n\n\t(cherry picked from commit ${OTHER_UPSTREAM})\n`,
    ].join('\x1e\n')
    const { picks, problems } = parseCherryPicks(log)
    expect(problems).toEqual([])
    expect(picks).toEqual([
      { commit: FORK_PICK, upstream: UPSTREAM },
      { commit: FORK_PARENT, upstream: OTHER_UPSTREAM },
    ])

    const violations = findLedgerViolations([], picks, FULL_HISTORY)
    expect(violations).toEqual([
      `${FORK_PICK} was cherry-picked from upstream ${UPSTREAM}, which has no ledger entry`,
      `${FORK_PARENT} was cherry-picked from upstream ${OTHER_UPSTREAM}, which has no ledger entry`,
    ])
  })

  it('reports a cherry-pick reference that is not a trailer line it can read', () => {
    const unreadable = (count: number) =>
      `${FORK_PICK}: ${count} cherry-pick reference(s) in its message are not a trailer line "(cherry picked from commit <sha>)" with a lowercase 7- to 40-character sha`
    for (const line of [
      `(cherry picked from commit ${'ABCDEF1234'.repeat(4)})`,
      `(cherry picked from commit ${UPSTREAM}) and reworded`,
      `> (cherry picked from commit ${UPSTREAM})`,
      `- (cherry picked from commit ${UPSTREAM})`,
      `(cherry picked from commit  ${UPSTREAM})`,
      `(cherry picked from commit\t${UPSTREAM})`,
      `(cherry picked from commit${UPSTREAM})`,
      '(cherry picked from commit abc12)',
      `(Cherry picked from commit ${UPSTREAM})`,
    ]) {
      const log = `${FORK_PICK}\x00fix: a pick\n\n${line}\n`
      expect(parseCherryPicks(log), line).toEqual({ picks: [], problems: [unreadable(1)] })
    }

    // A readable trailer does not hide an unreadable one in the same message.
    const mixed = `${FORK_PICK}\x00fix: two picks\n\n(cherry picked from commit ${UPSTREAM})\n(cherry picked from commit ${OTHER_UPSTREAM}) and more\n`
    expect(parseCherryPicks(mixed)).toEqual({
      picks: [{ commit: FORK_PICK, upstream: UPSTREAM }],
      problems: [unreadable(1)],
    })
  })

  it('does not report the trailer text in prose with a placeholder for the sha', () => {
    const log = `${FORK_PICK}\x00fix: document the check\n\n- a commit carrying \`(cherry picked from commit X)\` needs an entry\n- written as (cherry picked from commit <sha>)\n`
    expect(parseCherryPicks(log)).toEqual({ picks: [], problems: [] })
  })

  it('reports a git log record that does not start with a commit id', () => {
    const signed = `Good "git" signature for fixture@example.com with ED25519 key SHA256:x\n${FORK_PICK}\x00fix: a pick\n\n(cherry picked from commit ${UPSTREAM})\n`
    const { picks, problems } = parseCherryPicks(signed)
    expect(picks).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('git log printed a record that does not start with a commit id')
  })

  it('passes when every pick is recorded and every recorded fork commit is in history', () => {
    const picks = [{ commit: FORK_PICK, upstream: UPSTREAM }]
    expect(findLedgerViolations([entry()], picks, FULL_HISTORY)).toEqual([])
  })

  it('fails when a cherry-picked upstream commit has no ledger entry', () => {
    const picks = [
      { commit: FORK_PICK, upstream: UPSTREAM },
      { commit: FORK_PARENT, upstream: OTHER_UPSTREAM },
    ]
    const problems = findLedgerViolations([entry()], picks, FULL_HISTORY)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(OTHER_UPSTREAM)
    expect(problems[0]).toContain('no ledger entry')
  })

  it('fails when an entry names a fork commit that is not in history', () => {
    const problems = findLedgerViolations(
      [entry()],
      [],
      history([FORK_PARENT, MERGE_BASE], { [FORK_PICK]: PATCH_ID })
    )
    expect(problems).toEqual([
      `ledger entry 1 (upstream ${UPSTREAM}): downstream_commit ${FORK_PICK} is not in this branch's history`,
    ])

    const missingHead = findLedgerViolations([entry()], [], history([FORK_PICK, MERGE_BASE]))
    expect(missingHead.some((p) => p.includes(`downstream_head ${FORK_PARENT}`))).toBe(true)
  })

  it('fails when an entry records the wrong patch-id for its fork commit', () => {
    const problems = findLedgerViolations(
      [entry({ patch_id: '7'.repeat(40) })],
      [{ commit: FORK_PICK, upstream: UPSTREAM }],
      FULL_HISTORY
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('does not match')
  })

  it('fails when the entry for a pick names a different fork commit', () => {
    const problems = findLedgerViolations(
      [entry({ downstream_commit: FORK_PARENT, patch_id: PATCH_ID })],
      [{ commit: FORK_PICK, upstream: UPSTREAM }],
      history([FORK_PICK, FORK_PARENT, MERGE_BASE], { [FORK_PARENT]: PATCH_ID })
    )
    expect(problems).toEqual([
      `${FORK_PICK} was cherry-picked from upstream ${UPSTREAM}, but no accepted ledger entry for it has downstream_commit ${FORK_PICK}`,
      `ledger entry 1 (upstream ${UPSTREAM}): downstream_commit ${FORK_PARENT} carries no (cherry picked from commit ${UPSTREAM}) trailer`,
    ])
  })

  it('fails when the entry for a pick records no fork commit', () => {
    const problems = findLedgerViolations(
      [entry({ downstream_commit: undefined, patch_id: undefined })],
      [{ commit: FORK_PICK, upstream: UPSTREAM }],
      FULL_HISTORY
    )
    expect(problems).toEqual([
      `${FORK_PICK} was cherry-picked from upstream ${UPSTREAM}, but no accepted ledger entry for it has downstream_commit ${FORK_PICK}`,
    ])
  })

  it('fails when an entry records a fork commit without its patch-id, or the reverse', () => {
    const picks = [{ commit: FORK_PICK, upstream: UPSTREAM }]
    for (const partial of [{ patch_id: undefined }, { downstream_commit: undefined }]) {
      const problems = findLedgerViolations([entry(partial)], picks, FULL_HISTORY)
      expect(problems).toContain(
        `ledger entry 1 (upstream ${UPSTREAM}): downstream_commit and patch_id must be recorded together`
      )
    }
  })

  it('fails when the only entry for a pick was rejected or deferred', () => {
    for (const decision of ['rejected', 'deferred'] as const) {
      const problems = findLedgerViolations(
        [entry({ review: { decision } })],
        [{ commit: FORK_PICK, upstream: UPSTREAM }],
        FULL_HISTORY
      )
      expect(problems).toEqual([
        `${FORK_PICK} was cherry-picked from upstream ${UPSTREAM}, but no accepted ledger entry for it has downstream_commit ${FORK_PICK}`,
      ])
    }
  })

  it('accepts several records for one upstream commit: a later record adds to an earlier one', () => {
    const picks = [{ commit: FORK_PICK, upstream: UPSTREAM }]
    const undecided = { downstream_commit: undefined, patch_id: undefined }
    const deferred = entry({ ...undecided, review: { decision: 'deferred' } })
    expect(findLedgerViolations([deferred, entry()], picks, FULL_HISTORY)).toEqual([])
    const rejected = entry({ ...undecided, review: { decision: 'rejected' } })
    expect(findLedgerViolations([entry(), rejected], picks, FULL_HISTORY)).toEqual([])

    // Each record still has to hold on its own.
    const wrongPatchId = entry({ patch_id: '7'.repeat(40) })
    const problems = findLedgerViolations([entry(), wrongPatchId], picks, FULL_HISTORY)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('ledger entry 2')
    expect(problems[0]).toContain('does not match')
  })

  it('fails when an entry names a fork commit that carries no trailer for its upstream commit', () => {
    const problems = findLedgerViolations(
      [entry()],
      [{ commit: FORK_PICK, upstream: OTHER_UPSTREAM }],
      FULL_HISTORY
    )
    expect(problems).toContain(
      `ledger entry 1 (upstream ${UPSTREAM}): downstream_commit ${FORK_PICK} carries no (cherry picked from commit ${UPSTREAM}) trailer`
    )
  })

  it('holds a merge intake record to its own rules, not the cherry-pick ones', () => {
    const merge = entry({ intake: 'merge', patch_id: undefined })
    // No patch-id and no trailer are needed for a merge commit.
    expect(findLedgerViolations([merge], [], FULL_HISTORY)).toEqual([])

    const label = `ledger entry 1 (upstream ${UPSTREAM})`
    expect(findLedgerViolations([entry({ intake: 'merge' })], [], FULL_HISTORY)).toEqual([
      `${label}: a merge intake records no patch_id`,
    ])
    expect(
      findLedgerViolations(
        [entry({ intake: 'merge', downstream_commit: undefined, patch_id: undefined })],
        [],
        FULL_HISTORY
      )
    ).toEqual([`${label}: a merge intake names its merge commit as downstream_commit`])
    expect(
      findLedgerViolations(
        [entry({ neutralized_by: FORK_PARENT })],
        [{ commit: FORK_PICK, upstream: UPSTREAM }],
        FULL_HISTORY
      )
    ).toEqual([`${label}: neutralized_by belongs only on a merge intake record`])
    expect(
      findLedgerViolations(
        [{ ...merge, review: { decision: 'rejected' }, neutralized_by: '8'.repeat(40) }],
        [],
        FULL_HISTORY
      )
    ).toEqual([`${label}: neutralized_by ${'8'.repeat(40)} is not in this branch's history`])
  })

  it('does not let a merge intake record satisfy a cherry-pick', () => {
    // Even one naming the pick commit: a merge record's patch-id is not checked.
    const problems = findLedgerViolations(
      [entry({ intake: 'merge', patch_id: undefined })],
      [{ commit: FORK_PICK, upstream: UPSTREAM }],
      FULL_HISTORY
    )
    expect(problems).toEqual([
      `${FORK_PICK} was cherry-picked from upstream ${UPSTREAM}, but no accepted ledger entry for it has downstream_commit ${FORK_PICK}`,
    ])
  })

  it('rejects an unknown intake kind and a malformed neutralized_by', () => {
    expect(() => parseLedger(JSON.stringify({ ...entry(), intake: 'squash' }))).toThrow(
      'ledger line 1: intake must be "merge" when present'
    )
    expect(() => parseLedger(JSON.stringify({ ...entry(), neutralized_by: 'abc' }))).toThrow(
      'ledger line 1: neutralized_by must be a lowercase 40-character SHA'
    )
  })

  it('rejects a ledger line without a known review decision', () => {
    const { review: _review, ...unreviewed } = entry()
    expect(() => parseLedger(JSON.stringify(unreviewed))).toThrow(
      'ledger line 1: review.decision must be accepted, rejected or deferred'
    )
    const undecided = entry({ review: { decision: 'maybe' as never } })
    expect(() => parseLedger(JSON.stringify(undecided))).toThrow(
      'ledger line 1: review.decision must be accepted, rejected or deferred'
    )
  })

  it('rejects a ledger line that is not JSON or carries a malformed SHA', () => {
    expect(() => parseLedger('{"upstream_sha":')).toThrow('ledger line 1 is not valid JSON')
    const bad = JSON.stringify({ ...entry(), downstream_commit: 'abc' })
    expect(() => parseLedger(`${JSON.stringify(entry())}\n${bad}\n`)).toThrow(
      'ledger line 2: downstream_commit must be a lowercase 40-character SHA'
    )
  })
})

describe('REQ-21 committed upstream intake ledger', () => {
  const governance = JSON.parse(
    readFileSync(join(process.cwd(), '.venturi', 'repository-governance.json'), 'utf8')
  )
  const ledgerPath = join(process.cwd(), governance.authority.upstream.ledger)
  const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n')

  it('exists at the declared path and parses', () => {
    expect(lines.length).toBeGreaterThan(0)
    expect(parseLedger(readFileSync(ledgerPath, 'utf8'))).toHaveLength(lines.length)
  })

  it('holds only records the builder emits, none repeating an earlier decision', () => {
    const records = lines.map((line) => JSON.parse(line))
    for (const record of records) {
      const rebuilt = buildUpstreamIntakeRecord({
        upstream_sha: record.upstream_sha,
        merge_base: record.merge_base,
        downstream_head: record.downstream_head,
        downstream_patches: record.downstream_patches,
        tests: record.tests,
        reviewed_by: record.review.by,
        decision: record.review.decision,
        recorded_at: record.recorded_at,
        intake: record.intake,
        downstream_commit: record.downstream_commit,
        patch_id: record.patch_id,
        neutralized_by: record.neutralized_by,
        intake_pr: record.intake_pr,
        reason: record.reason,
        notes: record.notes,
      })
      expect(rebuilt).toEqual(record)
      expect(record.auto_merge).toBe(false)
      expect(record.source_update_mode).toBe('manual-review-only')
    }
    // The builder appends, and a later record for an upstream commit adds to an
    // earlier one, so only a repeat of the same decision on the same fork
    // commit is a duplicate.
    const keys = records.map((record) =>
      JSON.stringify([record.upstream_sha, record.downstream_commit ?? '', record.review.decision])
    )
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('upstream intake record builder', () => {
  const base = {
    upstream_sha: UPSTREAM,
    merge_base: MERGE_BASE,
    downstream_head: FORK_PARENT,
    downstream_patches: ['fork patches retained'],
    tests: ['ci: pass'],
    reviewed_by: 'reviewer',
    decision: 'accepted' as const,
    recorded_at: '2026-09-24T00:00:00.000Z',
  }

  it('records the fork commit, patch-id, intake pull request, reason and notes', () => {
    const record = buildUpstreamIntakeRecord({
      ...base,
      downstream_commit: FORK_PICK,
      patch_id: PATCH_ID,
      intake_pr: 126,
      reason: 'security fix',
      notes: 'applied out of upstream order',
    })
    expect(record).toMatchObject({
      downstream_commit: FORK_PICK,
      patch_id: PATCH_ID,
      intake_pr: 126,
      reason: 'security fix',
      notes: 'applied out of upstream order',
    })
  })

  it('omits the optional fields when they are not given', () => {
    const record = buildUpstreamIntakeRecord(base)
    for (const field of ['downstream_commit', 'patch_id', 'intake_pr', 'reason', 'notes']) {
      expect(record).not.toHaveProperty(field)
    }
  })

  it('rejects a malformed fork commit, patch-id or pull request number', () => {
    expect(() => buildUpstreamIntakeRecord({ ...base, downstream_commit: 'abc' })).toThrow(
      'downstream_commit must be a lowercase 40-character SHA'
    )
    expect(() => buildUpstreamIntakeRecord({ ...base, patch_id: 'ABC' })).toThrow(
      'patch_id must be a lowercase 40-character SHA'
    )
    expect(() => buildUpstreamIntakeRecord({ ...base, intake_pr: 0 })).toThrow(
      'intake_pr must be a positive pull request number'
    )
  })

  it('rejects a fork commit without its patch-id, and a patch-id without its fork commit', () => {
    expect(() => buildUpstreamIntakeRecord({ ...base, downstream_commit: FORK_PICK })).toThrow(
      'downstream_commit and patch_id must be recorded together'
    )
    expect(() => buildUpstreamIntakeRecord({ ...base, patch_id: PATCH_ID })).toThrow(
      'downstream_commit and patch_id must be recorded together'
    )
  })

  it('records a merge intake: the merge commit, no patch-id, and neutralized_by on a rejection', () => {
    const merge = { ...base, intake: 'merge' as const, downstream_commit: FORK_PICK }
    const accepted = buildUpstreamIntakeRecord(merge)
    expect(accepted).toMatchObject({ intake: 'merge', downstream_commit: FORK_PICK })
    expect(accepted).not.toHaveProperty('patch_id')
    expect(accepted).not.toHaveProperty('neutralized_by')

    const rejected = buildUpstreamIntakeRecord({
      ...merge,
      decision: 'rejected',
      neutralized_by: FORK_PARENT,
    })
    expect(rejected).toMatchObject({
      neutralized_by: FORK_PARENT,
      review: { decision: 'rejected' },
    })

    // A cherry-pick record carries no intake field at all.
    expect(buildUpstreamIntakeRecord(base)).not.toHaveProperty('intake')
  })

  it('rejects a merge intake without its merge commit, with a patch-id, or deferred', () => {
    const merge = { ...base, intake: 'merge' as const, downstream_commit: FORK_PICK }
    expect(() => buildUpstreamIntakeRecord({ ...merge, downstream_commit: undefined })).toThrow(
      'a merge intake names its merge commit as downstream_commit'
    )
    expect(() => buildUpstreamIntakeRecord({ ...merge, patch_id: PATCH_ID })).toThrow(
      'a merge intake records no patch_id'
    )
    expect(() => buildUpstreamIntakeRecord({ ...merge, decision: 'deferred' })).toThrow(
      'a merged upstream commit cannot be deferred'
    )
    expect(() => buildUpstreamIntakeRecord({ ...merge, decision: 'rejected' })).toThrow(
      'a rejected merged commit, and only one, records neutralized_by'
    )
    expect(() => buildUpstreamIntakeRecord({ ...merge, neutralized_by: FORK_PARENT })).toThrow(
      'a rejected merged commit, and only one, records neutralized_by'
    )
    expect(() =>
      buildUpstreamIntakeRecord({
        ...base,
        downstream_commit: FORK_PICK,
        patch_id: PATCH_ID,
        neutralized_by: FORK_PARENT,
      })
    ).toThrow('neutralized_by belongs only on a merge intake record')
    expect(() => buildUpstreamIntakeRecord({ ...merge, neutralized_by: 'abc' })).toThrow(
      'neutralized_by must be a lowercase 40-character SHA'
    )
  })
})

describe('pinned patch-id command', () => {
  // A throwaway repository with one commit whose diff has two nearby hunks and
  // blank context lines in file.txt, a file with a non-ASCII name, and a file
  // in a subdirectory whose content is latin-1, not UTF-8. Each setting in
  // `changesTheId` changes the unpinned id of that commit.
  let repo = ''
  let sha = ''
  // No caller git config or GIT_* environment reaches the fixture's own commands.
  const isolated: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  )

  function run(args: string[], input?: string): string {
    return execFileSync('git', args, { cwd: repo, env: isolated, encoding: 'utf8', input })
  }

  /** `git show --format= <sha> | git patch-id --stable`, piped as bytes like a shell. */
  function unpinnedPatchId(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
    const cwd = options.cwd ?? repo
    const env = options.env ?? isolated
    const diff = execFileSync('git', ['show', '--format=', sha], { cwd, env })
    const output = execFileSync('git', ['patch-id', '--stable'], {
      cwd,
      env,
      input: diff,
      encoding: 'utf8',
    })
    return output.split(' ')[0] ?? ''
  }

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'intake-ledger-patch-id-'))
    repo = join(root, 'repo')
    mkdirSync(join(repo, 'sub'), { recursive: true })
    const globalConfig = join(root, 'gitconfig')
    writeFileSync(globalConfig, '')
    Object.assign(isolated, {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      // Also keeps out the default attributes file, $XDG_CONFIG_HOME/git/attributes.
      XDG_CONFIG_HOME: root,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    })
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
    lines[2] = ''
    lines[15] = ''
    run(['-c', 'init.defaultBranch=main', 'init', '-q'])
    writeFileSync(join(repo, 'file.txt'), `${lines.join('\n')}\n`)
    writeFileSync(join(repo, 'caf\u00e9.txt'), 'before\n')
    writeFileSync(join(repo, 'sub', 'latin1.txt'), Buffer.from('caf\xe9\n', 'latin1'))
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'base'])
    lines[4] = 'line 5 changed'
    lines[13] = 'line 14 changed'
    writeFileSync(join(repo, 'file.txt'), `${lines.join('\n')}\n`)
    writeFileSync(join(repo, 'caf\u00e9.txt'), 'after\n')
    writeFileSync(join(repo, 'sub', 'latin1.txt'), Buffer.from('caf\xe9 au lait\n', 'latin1'))
    run(['commit', '-q', '-a', '-m', 'change'])
    sha = run(['rev-parse', 'HEAD']).trim()
  })

  afterAll(() => {
    if (repo) rmSync(join(repo, '..'), { recursive: true, force: true })
  })

  it('gives the same id under each pinned setting', () => {
    const pinned = patchIdOf(sha, repo)
    const unpinned = unpinnedPatchId()
    expect(pinned).toMatch(/^[0-9a-f]{40}$/)
    expect(pinned).toBe(unpinned)

    // Settings every supported git reads; each one changes the unpinned id.
    const changesTheId: Array<[string, string]> = [
      ['diff.noprefix', 'true'],
      ['diff.context', '1'],
      ['diff.interHunkContext', '10'],
      ['diff.suppressBlankEmpty', 'true'],
      // Prints the non-ASCII file name unquoted.
      ['core.quotePath', 'false'],
      // Treats every file larger than one byte as binary.
      ['core.bigFileThreshold', '1'],
    ]
    for (const [key, value] of changesTheId) {
      run(['config', key, value])
      try {
        expect(unpinnedPatchId(), key).not.toBe(unpinned)
        expect(patchIdOf(sha, repo), key).toBe(pinned)
      } finally {
        run(['config', '--unset', key])
      }
    }

    // An attribute that marks a file binary changes the unpinned id too.
    const attributes = join(repo, '.git', 'info', 'attributes')
    mkdirSync(join(repo, '.git', 'info'), { recursive: true })
    writeFileSync(attributes, 'file.txt -diff\n')
    try {
      expect(unpinnedPatchId(), 'file.txt -diff').not.toBe(unpinned)
      expect(patchIdOf(sha, repo), 'file.txt -diff').toBe(pinned)
    } finally {
      rmSync(attributes)
    }

    // Settings only newer git reads, or that leave this diff alone; still pinned.
    const alsoPinned: Array<[string, string]> = [
      ['diff.srcPrefix', 'x/'],
      ['diff.dstPrefix', 'y/'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.algorithm', 'patience'],
      ['diff.indentHeuristic', 'false'],
      ['diff.relative', 'true'],
      ['diff.ignoreSubmodules', 'all'],
      ['log.showSignature', 'true'],
    ]
    for (const [key, value] of alsoPinned) {
      run(['config', key, value])
      try {
        expect(patchIdOf(sha, repo), key).toBe(pinned)
      } finally {
        run(['config', '--unset', key])
      }
    }
  })

  it('gives the same id from a subdirectory under diff.relative', () => {
    const pinned = patchIdOf(sha, repo)
    const subdirectory = join(repo, 'sub')
    run(['config', 'diff.relative', 'true'])
    try {
      // Unpinned, the diff shrinks to sub/ and its paths lose the sub/ prefix.
      expect(unpinnedPatchId({ cwd: subdirectory })).not.toBe(pinned)
      expect(patchIdOf(sha, subdirectory)).toBe(pinned)
    } finally {
      run(['config', '--unset', 'diff.relative'])
    }
  })

  it('ignores GIT_DIFF_OPTS, which overrides --unified', () => {
    const pinned = patchIdOf(sha, repo)
    const hostile = { ...isolated, GIT_DIFF_OPTS: '--unified=1' }
    expect(unpinnedPatchId({ env: hostile })).not.toBe(pinned)
    const saved = process.env.GIT_DIFF_OPTS
    process.env.GIT_DIFF_OPTS = '--unified=1'
    try {
      expect(patchIdOf(sha, repo)).toBe(pinned)
    } finally {
      if (saved === undefined) delete process.env.GIT_DIFF_OPTS
      else process.env.GIT_DIFF_OPTS = saved
    }
  })

  it('hashes the diff as bytes, as the documented pipeline does', () => {
    // Decoding the diff as UTF-8 replaces the latin-1 byte, which changes the id.
    const decoded = execFileSync('git', ['show', '--format=', sha], {
      cwd: repo,
      env: isolated,
      encoding: 'utf8',
    })
    const fromDecoded = run(['patch-id', '--stable'], decoded).split(' ')[0]
    expect(fromDecoded).not.toBe(unpinnedPatchId())
    expect(patchIdOf(sha, repo)).toBe(unpinnedPatchId())
  })

  it('is the command the record builder documents', () => {
    const builder = readFileSync(
      join(process.cwd(), 'scripts', 'upstream-intake-ledger.ts'),
      'utf8'
    )
    expect(builder).toContain(PATCH_ID_COMMAND)
  })
})

describe('cherry-pick log reading', () => {
  // A throwaway repository whose pick commit is SSH-signed, with
  // log.showSignature=true and a signer file, so plain `git log` prints a
  // verification line in front of its commit id. Two later commits carry
  // references that only a search ignoring case and the space after "commit"
  // finds: one with a tab before the id, one capitalized.
  let repo = ''
  let pick = ''
  let tabbed = ''
  let capitalized = ''
  const isolated: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  )

  function run(args: string[]): string {
    return execFileSync('git', args, { cwd: repo, env: isolated, encoding: 'utf8' })
  }

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'intake-ledger-log-'))
    repo = join(root, 'repo')
    mkdirSync(repo)
    const globalConfig = join(root, 'gitconfig')
    writeFileSync(globalConfig, '')
    Object.assign(isolated, {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      // Also keeps out the default attributes file, $XDG_CONFIG_HOME/git/attributes.
      XDG_CONFIG_HOME: root,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    })
    const key = join(root, 'signing-key')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', key])
    const signers = join(root, 'allowed-signers')
    writeFileSync(signers, `fixture@example.com ${readFileSync(`${key}.pub`, 'utf8')}`)
    run(['-c', 'init.defaultBranch=main', 'init', '-q'])
    run(['config', 'gpg.format', 'ssh'])
    run(['config', 'user.signingKey', key])
    run(['config', 'gpg.ssh.allowedSignersFile', signers])
    run(['commit', '-q', '--allow-empty', '-m', 'base'])
    const message = `fix: a pick\n\n(cherry picked from commit ${UPSTREAM})`
    run(['commit', '-q', '--allow-empty', '-S', '-m', message])
    pick = run(['rev-parse', 'HEAD']).trim()
    const tab = `fix: tab\n\n(cherry picked from commit\t${UPSTREAM})`
    run(['commit', '-q', '--allow-empty', '-m', tab])
    tabbed = run(['rev-parse', 'HEAD']).trim()
    const capitals = `fix: case\n\n(Cherry picked from commit ${UPSTREAM})`
    run(['commit', '-q', '--allow-empty', '-m', capitals])
    capitalized = run(['rev-parse', 'HEAD']).trim()
    run(['config', 'log.showSignature', 'true'])
  })

  afterAll(() => {
    if (repo) rmSync(join(repo, '..'), { recursive: true, force: true })
  })

  it('reads a signed pick under log.showSignature=true', () => {
    // Without --no-show-signature, the verification line precedes the commit
    // id, and the record is reported rather than read as a pick.
    const shown = run(CHERRY_PICK_LOG_ARGS.filter((arg) => arg !== '--no-show-signature'))
    expect(shown).toContain('signature')
    const unpinned = parseCherryPicks(shown)
    expect(unpinned.picks).toEqual([])
    expect(
      unpinned.problems.filter((problem) => problem.includes('does not start with a commit id'))
    ).toHaveLength(1)

    expect(readCherryPicks(repo).picks).toEqual([{ commit: pick, upstream: UPSTREAM }])
  })

  it('finds a reference with a tab before the id or in another case, and reports it', () => {
    const unreadable = (commit: string) =>
      `${commit}: 1 cherry-pick reference(s) in its message are not a trailer line "(cherry picked from commit <sha>)" with a lowercase 7- to 40-character sha`
    expect(readCherryPicks(repo).problems).toEqual([unreadable(capitalized), unreadable(tabbed)])
  })
})

describe('merge intake check', () => {
  // A throwaway repository shaped like the fork:
  //
  //   main:     base ── f1 ── mTopic ── mIntake ── n1        (branch main)
  //                     └ t1 ┘          │                     (fork branch)
  //   upstream: base ── u1 ── u2 ───────┘   later: main ── mLater (merges u3)
  //                            └ u3 ──────────────────────────┘
  //
  // `base` plays the fork point. mIntake merges upstream u2 into the fork,
  // n1 undoes u1, and branch `later` merges upstream u3 on top of that.
  let repo = ''
  const sha: Record<string, string> = {}
  const isolated: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  )

  function run(args: string[]): string {
    return execFileSync('git', args, { cwd: repo, env: isolated, encoding: 'utf8' }).trim()
  }

  function commit(name: string): void {
    writeFileSync(join(repo, `${name}.txt`), `${name}\n`)
    run(['add', `${name}.txt`])
    run(['commit', '-q', '-m', name])
    sha[name] = run(['rev-parse', 'HEAD'])
  }

  function merge(name: string, other: string): void {
    run(['merge', '-q', '--no-ff', '--no-edit', '-m', name, other])
    sha[name] = run(['rev-parse', 'HEAD'])
  }

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'intake-ledger-merge-'))
    repo = join(root, 'repo')
    mkdirSync(repo)
    const globalConfig = join(root, 'gitconfig')
    writeFileSync(globalConfig, '')
    Object.assign(isolated, {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      XDG_CONFIG_HOME: root,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    })
    run(['-c', 'init.defaultBranch=main', 'init', '-q'])
    commit('base')
    run(['checkout', '-q', '-b', 'upstream'])
    commit('u1')
    commit('u2')
    run(['checkout', '-q', 'main'])
    commit('f1')
    run(['checkout', '-q', '-b', 'topic'])
    commit('t1')
    run(['checkout', '-q', 'main'])
    merge('mTopic', 'topic')
    merge('mIntake', 'upstream')
    commit('n1')
    run(['checkout', '-q', 'upstream'])
    commit('u3')
    run(['checkout', '-q', '-b', 'later', 'main'])
    merge('mLater', 'upstream')
    run(['checkout', '-q', 'main'])
  })

  afterAll(() => {
    if (repo) rmSync(join(repo, '..'), { recursive: true, force: true })
  })

  function record(upstream: string, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
    return {
      intake: 'merge',
      upstream_sha: sha[upstream]!,
      merge_base: sha.base!,
      downstream_head: sha.mTopic!,
      downstream_commit: sha.mIntake!,
      review: { decision: 'accepted' },
      ...overrides,
    }
  }

  const complete = () => [
    record('u1', { review: { decision: 'rejected' }, neutralized_by: sha.n1 }),
    record('u2'),
  ]

  function check(entries: LedgerEntry[], head = 'main'): string[] {
    return findMergeIntakeViolations(entries, gitMergeHistory(repo, head), sha.base)
  }

  it('fails when a merge brings upstream history in and no record names it', () => {
    expect(check([])).toEqual([
      `merge ${sha.mIntake} brings upstream history into this branch (merge base ${sha.base}), but no merge intake record names it as downstream_commit`,
    ])
  })

  it('passes with one record per commit the merge brought in, and ignores fork branch merges', () => {
    expect(check(complete())).toEqual([])
  })

  it('fails when a commit the merge brought in has no record', () => {
    expect(check([record('u2')])).toEqual([
      `merge ${sha.mIntake} brought in upstream commit ${sha.u1}, which has no merge intake record naming ${sha.mIntake}`,
    ])
  })

  it('fails when a record does not hold against the merge it names', () => {
    const label = (n: number, upstream: string) => `ledger entry ${n} (upstream ${sha[upstream]})`
    const [u1] = complete()
    expect(check([u1!, record('u2', { downstream_head: sha.f1 })])).toContain(
      `${label(2, 'u2')}: downstream_head ${sha.f1} is not a parent of merge ${sha.mIntake}`
    )
    expect(check([...complete(), record('base')])).toContain(
      `${label(3, 'base')}: merge ${sha.mIntake} did not bring in ${sha.base}`
    )
    expect(check([u1!, record('u2', { merge_base: sha.f1 })])).toEqual([
      `${label(2, 'u2')}: merge_base ${sha.f1} is not a merge base of ${sha.mTopic} and ${sha.u2}`,
    ])
    expect(check([u1!, record('u2', { downstream_commit: sha.n1 })])).toContain(
      `${label(2, 'u2')}: downstream_commit ${sha.n1} is not a merge commit`
    )
  })

  it('requires an accepted record, or a rejected one undone by a later fork commit', () => {
    const label = `ledger entry 1 (upstream ${sha.u1})`
    const u2 = record('u2')
    expect(check([record('u1', { review: { decision: 'deferred' } }), u2])).toEqual([
      `${label}: a merged upstream commit cannot be deferred; record it accepted, or rejected with neutralized_by`,
    ])
    expect(check([record('u1', { review: { decision: 'rejected' } }), u2])).toEqual([
      `${label}: a rejected merged commit names the fork commit that undoes it as neutralized_by`,
    ])
    expect(check([record('u1', { neutralized_by: sha.n1 }), u2])).toEqual([
      `${label}: neutralized_by belongs only on a rejected record`,
    ])
    for (const early of [sha.f1!, sha.mIntake!]) {
      const rejected = record('u1', { review: { decision: 'rejected' }, neutralized_by: early })
      expect(check([rejected, u2])).toEqual([
        `${label}: neutralized_by ${early} does not come after merge ${sha.mIntake}`,
      ])
    }
  })

  it('finds a later intake on top of a recorded one through the recorded upstream commit', () => {
    // Without records, the later merge's base (u2) is not yet known upstream,
    // so only the first intake is reported, through the fork point.
    expect(check([], 'later')).toEqual([
      `merge ${sha.mIntake} brings upstream history into this branch (merge base ${sha.base}), but no merge intake record names it as downstream_commit`,
    ])
    expect(check(complete(), 'later')).toEqual([
      `merge ${sha.mLater} brings upstream history into this branch (merge base ${sha.u2}), but no merge intake record names it as downstream_commit`,
    ])
    const later = record('u3', {
      merge_base: sha.u2,
      downstream_head: sha.n1,
      downstream_commit: sha.mLater,
    })
    expect(check([...complete(), later], 'later')).toEqual([])
  })
})
