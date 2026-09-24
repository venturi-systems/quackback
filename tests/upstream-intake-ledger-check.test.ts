import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  findLedgerViolations,
  parseCherryPicks,
  parseLedger,
  patchIdOf,
  PATCH_ID_COMMAND,
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

    expect(parseCherryPicks(log)).toEqual([
      { commit: FORK_PICK, upstream: UPSTREAM },
      { commit: MERGE_BASE, upstream: UPSTREAM },
      { commit: MERGE_BASE, upstream: OTHER_UPSTREAM },
    ])
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

  it('holds only records the builder emits, one per upstream commit', () => {
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
        downstream_commit: record.downstream_commit,
        patch_id: record.patch_id,
        intake_pr: record.intake_pr,
        reason: record.reason,
        notes: record.notes,
      })
      expect(rebuilt).toEqual(record)
      expect(record.auto_merge).toBe(false)
      expect(record.source_update_mode).toBe('manual-review-only')
    }
    const upstreams = records.map((record) => record.upstream_sha)
    expect(new Set(upstreams).size).toBe(upstreams.length)
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
})

describe('pinned patch-id command', () => {
  // A throwaway repository with one commit whose diff has two nearby hunks and
  // blank context lines, so each pinned setting changes the unpinned id.
  let repo = ''
  let sha = ''
  // No caller git config or GIT_* environment reaches the fixture's own commands.
  const isolated = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  )

  function run(args: string[], input?: string): string {
    return execFileSync('git', args, { cwd: repo, env: isolated, encoding: 'utf8', input })
  }

  function unpinnedPatchId(): string {
    return run(['patch-id', '--stable'], run(['show', '--format=', sha])).split(' ')[0] ?? ''
  }

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'intake-ledger-patch-id-'))
    repo = join(root, 'repo')
    mkdirSync(repo)
    const globalConfig = join(root, 'gitconfig')
    writeFileSync(globalConfig, '')
    Object.assign(isolated, {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
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
    run(['add', 'file.txt'])
    run(['commit', '-q', '-m', 'base'])
    lines[4] = 'line 5 changed'
    lines[13] = 'line 14 changed'
    writeFileSync(join(repo, 'file.txt'), `${lines.join('\n')}\n`)
    run(['commit', '-q', '-a', '-m', 'change'])
    sha = run(['rev-parse', 'HEAD']).trim()
  })

  afterAll(() => {
    if (repo) rmSync(join(repo, '..'), { recursive: true, force: true })
  })

  it('gives the same id under any diff configuration', () => {
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
    ]
    for (const [key, value] of changesTheId) {
      run(['config', key, value])
      expect(unpinnedPatchId(), key).not.toBe(unpinned)
      expect(patchIdOf(sha, repo), key).toBe(pinned)
      run(['config', '--unset', key])
    }

    // Settings only newer git reads, or that leave this diff alone; still pinned.
    const alsoPinned: Array<[string, string]> = [
      ['diff.srcPrefix', 'x/'],
      ['diff.dstPrefix', 'y/'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.algorithm', 'patience'],
      ['diff.indentHeuristic', 'false'],
    ]
    for (const [key, value] of alsoPinned) {
      run(['config', key, value])
      expect(patchIdOf(sha, repo), key).toBe(pinned)
      run(['config', '--unset', key])
    }
  })

  it('is the command the record builder documents', () => {
    const builder = readFileSync(join(process.cwd(), 'scripts', 'upstream-intake-ledger.ts'), 'utf8')
    expect(builder).toContain(PATCH_ID_COMMAND)
  })
})
