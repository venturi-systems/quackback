#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'

const FULL_SHA = /^[0-9a-f]{40}$/
const OPTIONAL_SHAS: readonly string[] = ['downstream_commit', 'patch_id', 'neutralized_by']

/**
 * One reviewed upstream intake. For a `git cherry-pick -x` intake:
 * - `downstream_head` is the fork commit the pick was applied onto;
 * - `merge_base` is the merge base of `downstream_head` and `upstream_sha`;
 * - `downstream_commit` is the fork commit the pick produced, which must carry
 *   the `(cherry picked from commit <upstream_sha>)` trailer on a line of its
 *   own;
 * - `patch_id` is that commit's patch-id, computed exactly as
 *   `scripts/check-upstream-intake-ledger.ts` recomputes it (`PATCH_ID_COMMAND`):
 *   `env -u GIT_DIFF_OPTS git -c core.quotePath=true -c diff.suppressBlankEmpty=false show --no-color --no-ext-diff --no-relative --no-renames --no-textconv --text --ignore-submodules=none --submodule=short --no-show-signature --diff-algorithm=histogram --indent-heuristic --unified=3 --inter-hunk-context=0 --src-prefix=a/ --dst-prefix=b/ --format= <sha> | git patch-id --stable`.
 *   Each setting that command pins can change the id. `PATCH_ID_SHOW_ARGS`
 *   in that script lists exactly which configuration the id is independent of.
 * `downstream_commit` and `patch_id` are recorded together or not at all. A
 * pick is satisfied only by an `accepted` record that names it as
 * `downstream_commit`.
 *
 * A merge intake (`intake: 'merge'`) records one record per upstream commit
 * the merge commit brought in:
 * - `downstream_commit` is the merge commit, and there is no `patch_id`;
 * - `downstream_head` is the merge's fork-side parent;
 * - `merge_base` is a merge base of `downstream_head` and `upstream_sha`;
 * - the decision is `accepted`, or `rejected` with `neutralized_by`, the later
 *   fork commit that undoes the upstream change. A merged commit is in the
 *   tree, so it cannot be `deferred`.
 *
 * The ledger is append-only. This script appends each record, and a later
 * record for the same `upstream_sha` adds to an earlier one; it does not
 * replace it. The check reads every record: each must hold against history on
 * its own, and a pick is satisfied when any `accepted` record names it. A later
 * `rejected` or `deferred` record therefore does not withdraw an earlier
 * acceptance.
 *
 * Provenance: `review.by` names who made the decision, and
 * `review.merged_by`, when given, names who merged the intake pull request.
 * They are different people when an agent prepared the intake and a person
 * merged it without a recorded review; `review.by` then names the agent and
 * says that no human review was recorded.
 *
 * A provenance amendment (`amends_line`) corrects who decided or merged an
 * earlier record without editing that line. It names the earlier record's
 * 1-based line number and repeats that record's identity (`intake`,
 * `upstream_sha`, `merge_base`, `downstream_head`, `downstream_commit`,
 * `patch_id`, `neutralized_by`, `intake_pr` and `review.decision`), which the
 * check compares; it cannot change a decision or the intake pull request. A
 * decision changes only through an ordinary later record. An amendment names
 * an ordinary record, never another amendment, and a record takes at most one
 * amendment, so the check refuses a second amendment of a line however it is
 * addressed.
 *
 * `scripts/check-upstream-intake-ledger.ts` enforces the ledger in CI.
 */
export interface UpstreamIntakeInput {
  /** `merge` for a merge intake; omitted for a cherry-pick. */
  intake?: 'merge'
  upstream_sha: string
  merge_base: string
  downstream_head: string
  downstream_patches: string[]
  tests: string[]
  /** Who made the decision: a person, or the agent that prepared the intake. */
  reviewed_by: string
  decision: 'accepted' | 'rejected' | 'deferred'
  /** Who merged the intake pull request, when that is not `reviewed_by`. */
  merged_by?: string
  /** On a provenance amendment: the 1-based ledger line it amends. */
  amends_line?: number
  recorded_at?: string
  downstream_commit?: string
  patch_id?: string
  neutralized_by?: string
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
    ['neutralized_by', input.neutralized_by],
  ] as const) {
    if (value === undefined && OPTIONAL_SHAS.includes(name)) continue
    if (!FULL_SHA.test(value ?? '')) {
      throw new Error(`${name} must be a lowercase 40-character SHA`)
    }
  }
  if (input.intake !== undefined && input.intake !== 'merge') {
    throw new Error("intake must be 'merge' when given")
  }
  if (input.intake === 'merge') {
    if (input.downstream_commit === undefined) {
      throw new Error('a merge intake names its merge commit as downstream_commit')
    }
    if (input.patch_id !== undefined) throw new Error('a merge intake records no patch_id')
    if (input.decision === 'deferred') {
      throw new Error('a merged upstream commit cannot be deferred')
    }
    if ((input.decision === 'rejected') !== (input.neutralized_by !== undefined)) {
      throw new Error('a rejected merged commit, and only one, records neutralized_by')
    }
  } else {
    if ((input.downstream_commit === undefined) !== (input.patch_id === undefined)) {
      throw new Error('downstream_commit and patch_id must be recorded together')
    }
    if (input.neutralized_by !== undefined) {
      throw new Error('neutralized_by belongs only on a merge intake record')
    }
  }
  if (input.downstream_patches.length === 0) {
    throw new Error('at least one downstream patch disposition is required')
  }
  if (input.tests.length === 0) throw new Error('at least one test result is required')
  if (!input.reviewed_by.trim()) throw new Error('reviewed_by is required')
  if (input.merged_by !== undefined && !input.merged_by.trim()) {
    throw new Error('merged_by must not be empty when given')
  }
  const amends = input.amends_line
  if (amends !== undefined && !(Number.isInteger(amends) && amends > 0)) {
    throw new Error('amends_line must be a positive ledger line number')
  }
  const pr = input.intake_pr
  if (pr !== undefined && !(Number.isInteger(pr) && pr > 0)) {
    throw new Error('intake_pr must be a positive pull request number')
  }

  return {
    schema_version: 1,
    source_update_mode: 'manual-review-only',
    auto_merge: false,
    ...(input.intake !== undefined && { intake: input.intake }),
    upstream_sha: input.upstream_sha,
    merge_base: input.merge_base,
    downstream_head: input.downstream_head,
    ...(input.downstream_commit !== undefined && { downstream_commit: input.downstream_commit }),
    ...(input.patch_id !== undefined && { patch_id: input.patch_id }),
    ...(input.neutralized_by !== undefined && { neutralized_by: input.neutralized_by }),
    ...(input.amends_line !== undefined && { amends_line: input.amends_line }),
    downstream_patches: input.downstream_patches,
    tests: input.tests,
    review: {
      by: input.reviewed_by,
      decision: input.decision,
      ...(input.merged_by !== undefined && { merged_by: input.merged_by }),
    },
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
  const amendsLine = optional('--amends-line')
  const intake = optional('--intake')
  if (intake !== undefined && intake !== 'merge') throw new Error("--intake must be 'merge'")
  const record = buildUpstreamIntakeRecord({
    intake: intake as UpstreamIntakeInput['intake'],
    upstream_sha: value('--upstream-sha'),
    merge_base: value('--merge-base'),
    downstream_head: value('--downstream-head'),
    downstream_patches: values('--downstream-patch'),
    tests: values('--test'),
    reviewed_by: value('--reviewed-by'),
    decision,
    merged_by: optional('--merged-by'),
    amends_line: amendsLine === undefined ? undefined : Number(amendsLine),
    downstream_commit: optional('--downstream-commit'),
    patch_id: optional('--patch-id'),
    neutralized_by: optional('--neutralized-by'),
    intake_pr: intakePr === undefined ? undefined : Number(intakePr),
    reason: optional('--reason'),
    notes: optional('--notes'),
  })
  const output = value('--output') || 'upstream-intake-ledger.jsonl'
  appendFileSync(output, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  console.log(JSON.stringify(record, null, 2))
}
