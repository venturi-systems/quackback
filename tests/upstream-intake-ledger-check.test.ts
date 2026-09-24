import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findLedgerViolations,
  parseCherryPicks,
  parseLedger,
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
})
