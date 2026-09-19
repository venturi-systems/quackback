#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'

const FULL_SHA = /^[0-9a-f]{40}$/

export interface UpstreamIntakeInput {
  upstream_sha: string
  merge_base: string
  downstream_head: string
  downstream_patches: string[]
  tests: string[]
  reviewed_by: string
  decision: 'accepted' | 'rejected' | 'deferred'
  recorded_at?: string
}

export function buildUpstreamIntakeRecord(input: UpstreamIntakeInput) {
  for (const [name, value] of [
    ['upstream_sha', input.upstream_sha],
    ['merge_base', input.merge_base],
    ['downstream_head', input.downstream_head],
  ]) {
    if (!FULL_SHA.test(value)) throw new Error(`${name} must be a lowercase 40-character SHA`)
  }
  if (input.downstream_patches.length === 0) {
    throw new Error('at least one downstream patch disposition is required')
  }
  if (input.tests.length === 0) throw new Error('at least one test result is required')
  if (!input.reviewed_by.trim()) throw new Error('reviewed_by is required')

  return {
    schema_version: 1,
    source_update_mode: 'manual-review-only',
    auto_merge: false,
    upstream_sha: input.upstream_sha,
    merge_base: input.merge_base,
    downstream_head: input.downstream_head,
    downstream_patches: input.downstream_patches,
    tests: input.tests,
    review: { by: input.reviewed_by, decision: input.decision },
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

if (import.meta.main) {
  const decision = value('--decision') as UpstreamIntakeInput['decision']
  if (!['accepted', 'rejected', 'deferred'].includes(decision)) {
    throw new Error('--decision must be accepted, rejected, or deferred')
  }
  const record = buildUpstreamIntakeRecord({
    upstream_sha: value('--upstream-sha'),
    merge_base: value('--merge-base'),
    downstream_head: value('--downstream-head'),
    downstream_patches: values('--downstream-patch'),
    tests: values('--test'),
    reviewed_by: value('--reviewed-by'),
    decision,
  })
  const output = value('--output') || 'upstream-intake-ledger.jsonl'
  appendFileSync(output, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  console.log(JSON.stringify(record, null, 2))
}
