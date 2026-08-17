import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildUpstreamIntakeRecord } from '../scripts/upstream-intake-ledger'

const workflowDir = join(process.cwd(), '.github', 'workflows')

function workflowFiles(): string[] {
  return readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
}

describe('QB-CI-001 consolidated validation contract', () => {
  it('uses one hosted pull-request and merge-queue job', () => {
    const workflows = workflowFiles()
    const contents = new Map(
      workflows.map((name) => [name, readFileSync(join(workflowDir, name), 'utf8')])
    )
    const pullRequestProducers = workflows.filter((name) =>
      /^ {2}pull_request:/m.test(contents.get(name) ?? '')
    )
    const mergeGroupProducers = workflows.filter((name) =>
      /^ {2}merge_group:/m.test(contents.get(name) ?? '')
    )

    expect(pullRequestProducers).toEqual(['ci.yml'])
    expect(mergeGroupProducers).toEqual(['ci.yml'])

    const ci = contents.get('ci.yml') ?? ''
    const jobs = ci.split('\njobs:\n', 2)[1]?.match(/^ {2}[a-z0-9-]+:/gm) ?? []
    expect(jobs).toEqual(['  portability-gate:'])
    expect(ci).toContain('name: portability-gate')
    expect(ci).toContain('runs-on: ubuntu-latest')
    expect(ci).toContain('services:\n      postgres:')
    expect(ci).toContain('docker run --rm --read-only --network none')
    expect(ci).toContain(
      'ghcr.io/venturi-systems/repository-governance-validator@sha256:9687a75b75ec9d653a3ede789a6baa05bdc1dd1c2711aac476f7990b15eb1fc7'
    )
    expect(ci).not.toContain('uses: docker://')
    expect(ci).toContain('--volume "$GITHUB_WORKSPACE:/github/workspace:ro"')
    expect(ci).toContain('--manifest .venturi/repository-governance.json')
    expect(ci).toContain('--repository "$GITHUB_REPOSITORY"')
    expect(ci).toContain('--root /github/workspace')
    expect(ci).not.toContain('venturi-systems/.github/.github/actions/repository-governance@')
    expect(ci).toContain('Check fork portability contract')
    expect(ci).toContain('bun run lint')
    expect(ci).toContain('bun run build')
    expect(ci).toContain('bun run db:migrate')
    expect(ci).toContain('bun run test --run')
    expect(ci.toLowerCase()).not.toContain('codebuild-')
  })
})

describe('root dependency contract', () => {
  it('does not install the unused native image-processing stack', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    const lockfile = readFileSync(join(process.cwd(), 'bun.lock'), 'utf8')

    expect(packageJson.devDependencies?.sharp).toBeUndefined()
    expect(lockfile).not.toContain('"sharp": ["sharp@')
  })

  it('builds the production runner from patched, immutable Bun bases', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'apps', 'web', 'Dockerfile'), 'utf8')

    expect(dockerfile).toContain(
      'FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS base'
    )
    expect(dockerfile).toContain(
      'FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runner'
    )
    expect(dockerfile).toContain('libcrypto3=3.5.7-r0')
    expect(dockerfile).toContain('libssl3=3.5.7-r0')
    expect(dockerfile).toContain('openssl=3.5.7-r0')
  })
})

const REQUIRED_GOVERNANCE_KEYS = [
  'schema_version',
  'repository',
  'authority',
  'harness',
  'validation',
  'runners',
  'identities',
  'environments',
  'schedules',
  'deployment',
  'release',
  'recovery',
  'evidence',
  'cost',
]

describe('QB-GOV-001 repository governance contract', () => {
  it('declares the repository-specific authority and cost model', () => {
    const path = join(process.cwd(), '.venturi', 'repository-governance.json')
    expect(existsSync(path)).toBe(true)
    const contract = JSON.parse(readFileSync(path, 'utf8'))

    expect(REQUIRED_GOVERNANCE_KEYS.every((key) => key in contract)).toBe(true)
    expect(contract.repository).toEqual({
      owner: 'venturi-systems',
      name: 'quackback',
      default_branch: 'main',
    })
    expect(contract.authority.upstream.mode).toBe('manual-reviewed-intake')
    expect(contract.validation.authoritative_contexts).toEqual(['portability-gate'])
    expect(contract.schedules).toEqual([])
    const scheduledWorkflows = readdirSync(workflowDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .filter((name) => /^ {2}schedule:\s*$/m.test(readFileSync(join(workflowDir, name), 'utf8')))
      .sort()
    expect(
      contract.schedules.map((schedule: { workflow: string }) => schedule.workflow).sort()
    ).toEqual(scheduledWorkflows)
    expect(contract.cost.cache_policy).toBe('per-architecture-gha')
  })

  it('pins dormant actions and makes every manual release a dry-run by default', () => {
    const widget = readFileSync(join(workflowDir, 'publish-widget.yml'), 'utf8')
    const openapi = readFileSync(join(workflowDir, 'release-openapi.yml'), 'utf8')

    expect(widget).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
    expect(widget).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020')
    expect(openapi).toContain('actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803')
    for (const workflow of [widget, openapi]) {
      expect(workflow).toContain('dry_run:')
      expect(workflow).toContain('default: true')
      expect(workflow).toContain("github.repository == 'venturi-systems/quackback'")
      expect(workflow).toMatch(/\nconcurrency:\n {2}group: .+\n {2}cancel-in-progress: false\n/)
      expect(workflow).toMatch(/\n {4}timeout-minutes: \d+\n/)
    }
    expect(widget).toContain('npm pack --dry-run')
    expect(openapi).toContain("if: github.event_name == 'release' || inputs.dry_run == false")
    expect(widget.split('\n  publish:\n')[0]).not.toContain('id-token: write')
    expect(openapi.split('\n  upload-release:\n')[0]).not.toContain('contents: write')
  })

  it('provides a manual-review-only upstream intake ledger', () => {
    const ledger = readFileSync(join(process.cwd(), 'scripts', 'upstream-intake-ledger.ts'), 'utf8')
    expect(ledger).toContain("source_update_mode: 'manual-review-only'")
    expect(ledger).toContain('auto_merge: false')
    expect(ledger).toContain('downstream_patches')
    expect(ledger).toContain('tests')
    expect(ledger).not.toContain('git merge')
    expect(ledger).not.toContain('git pull')

    const record = buildUpstreamIntakeRecord({
      upstream_sha: 'a'.repeat(40),
      merge_base: 'b'.repeat(40),
      downstream_head: 'c'.repeat(40),
      downstream_patches: ['QB-1: retained'],
      tests: ['bun test tests/ci-contract.test.ts: pass'],
      reviewed_by: 'automation',
      decision: 'accepted',
      recorded_at: '2026-08-15T00:00:00.000Z',
    })
    expect(record.auto_merge).toBe(false)
    expect(record.review.decision).toBe('accepted')
  })
})
