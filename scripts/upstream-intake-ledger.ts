#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'

const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * One reviewed upstream intake. For a `git cherry-pick -x` intake:
 * - `downstream_head` is the fork commit the pick was applied onto;
 * - `merge_base` is the merge base of `downstream_head` and `upstream_sha`;
 * - `downstream_commit` is the fork commit the pick produced;
 * - `patch_id` is that commit's patch-id, computed exactly as
 *   `scripts/check-upstream-intake-ledger.ts` recomputes it:
 *   `git show --no-color --no-ext-diff --no-renames --diff-algorithm=histogram --format= <sha> | git patch-id --stable`.
 *   The diff algorithm is pinned because it changes the patch-id.
 *
 * `scripts/check-upstream-intake-ledger.ts` enforces the ledger in CI.
 */
export interface UpstreamIntakeInput {
  upstream_sha: string
  merge_base: string
  downstream_head: string
  downstream_patches: string[]
  tests: string[]
  reviewed_by: string
  decision: 'accepted' | 'rejected' | 'deferred'
  recorded_at?: string
  downstream_commit?: string
  patch_id?: string
  intake_pr?: number
  reason?: string
  notes?: string
}

export function buildUpstreamIntakeRecord(input: UpstreamIntakeInput) {
  for (const [name, value] of [
    ['upstream_sha', input.upstream_sha],
    ['merge_base', input.merge_base],
    ['downstream_head', input.downstream_head],
    ['downstream_commit', input.downstream_commit],
    ['patch_id', input.patch_id],
  ] as const) {
    if (value === undefined && (name === 'downstream_commit' || name === 'patch_id')) continue
    if (!FULL_SHA.test(value ?? '')) {
      throw new Error(`${name} must be a lowercase 40-character SHA`)
    }
  }
  if (input.downstream_patches.length === 0) {
    throw new Error('at least one downstream patch disposition is required')
  }
  if (input.tests.length === 0) throw new Error('at least one test result is required')
  if (!input.reviewed_by.trim()) throw new Error('reviewed_by is required')
  const pr = input.intake_pr
  if (pr !== undefined && !(Number.isInteger(pr) && pr > 0)) {
    throw new Error('intake_pr must be a positive pull request number')
  }

  return {
    schema_version: 1,
    source_update_mode: 'manual-review-only',
    auto_merge: false,
    upstream_sha: input.upstream_sha,
    merge_base: input.merge_base,
    downstream_head: input.downstream_head,
    ...(input.downstream_commit !== undefined && { downstream_commit: input.downstream_commit }),
    ...(input.patch_id !== undefined && { patch_id: input.patch_id }),
    downstream_patches: input.downstream_patches,
    tests: input.tests,
    review: { by: input.reviewed_by, decision: input.decision },
    ...(input.intake_pr !== undefined && { intake_pr: input.intake_pr }),
    ...(input.reason !== undefined && { reason: input.reason }),
    ...(input.notes !== undefined && { notes: input.notes }),
    recorded_at: input.recorded_at ?? new Date().toISOString(),
  }
}

function values(flag: string): string[] {
  const result: string[] = []
  for (let index = 0; index < Bun.argv.length; index += 1) {
    if (Bun.argv[index] === flag && Bun.argv[index + 1]) result.push(Bun.argv[index + 1])
  }
  return result
}

function value(flag: string): string {
  return values(flag)[0] ?? ''
}

function optional(flag: string): string | undefined {
  return values(flag)[0]
}

if (import.meta.main) {
  const decision = value('--decision') as UpstreamIntakeInput['decision']
  if (!['accepted', 'rejected', 'deferred'].includes(decision)) {
    throw new Error('--decision must be accepted, rejected, or deferred')
  }
  const intakePr = optional('--intake-pr')
  const record = buildUpstreamIntakeRecord({
    upstream_sha: value('--upstream-sha'),
    merge_base: value('--merge-base'),
    downstream_head: value('--downstream-head'),
    downstream_patches: values('--downstream-patch'),
    tests: values('--test'),
    reviewed_by: value('--reviewed-by'),
    decision,
    downstream_commit: optional('--downstream-commit'),
    patch_id: optional('--patch-id'),
    intake_pr: intakePr === undefined ? undefined : Number(intakePr),
    reason: optional('--reason'),
    notes: optional('--notes'),
  })
  const output = value('--output') || 'upstream-intake-ledger.jsonl'
  appendFileSync(output, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  console.log(JSON.stringify(record, null, 2))
}
