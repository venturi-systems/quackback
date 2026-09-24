import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildUpstreamIntakeRecord } from '../scripts/upstream-intake-ledger'

const workflowDir = join(process.cwd(), '.github', 'workflows')

function workflowFiles(): string[] {
  return readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
}

describe('QB-CI-001 consolidated validation contract', () => {
  it('splits independent lanes behind one pull-request and merge-queue context', () => {
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
    const jobs = ci.split('\njobs:\n', 2)[1]?.match(/^ {2}[a-z0-9_-]+:/gm) ?? []
    expect(jobs).toEqual([
      '  static_analysis:',
      '  database_tests:',
      '  changed_paths:',
      '  e2e_tests:',
      '  signed_in_render:',
      '  portability_gate:',
    ])
    expect(ci).toContain('name: Static analysis')
    expect(ci).toContain('name: Database migrations and tests')
    // main made the required gate's name a conditional expression so a
    // workflow_dispatch run publishes a DIFFERENT check name and cannot post a
    // verdict for the required `portability-gate` context. Assert that
    // expression rather than a literal `name: portability-gate`, which the
    // conditional no longer contains.
    expect(ci).toContain("github.event_name == 'workflow_dispatch'")
    expect(ci).toContain("'portability-gate (manual diagnostic)'")
    expect(ci).toContain("|| 'portability-gate'")
    expect(ci).toContain('needs: [static_analysis, database_tests, changed_paths, e2e_tests]')
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
    // The widget suite used to run only on a `widget-v*` tag, and the Playwright
    // suite ran nowhere at all. Both are pull-request lanes now; pin the command
    // so neither can be dropped back out silently.
    expect(ci).toContain('bun run --filter @quackback/widget test')
    expect(ci).toContain('bun run test:e2e')
    expect(ci).toContain(
      'bunx playwright test --list --reporter=json --shard=${{ matrix.shard }}/8 > e2e-plan.json'
    )
    expect(ci).toContain(
      'check-known-failures.ts e2e-results.json e2e/known-failures.json e2e-plan.json'
    )
    expect(ci.indexOf('name: Collect the expected tests for this shard')).toBeLessThan(
      ci.indexOf('name: Run the Playwright suite')
    )
    expect(ci).toContain('name: End-to-end tests')
    // The end-to-end lane is changed-path gated AND merge-queue reusable, so
    // the required gate has to tolerate `skipped` -- but ONLY for one of the
    // two positive reasons changed_paths records, only alongside a successful
    // filter job, and never with `continue-on-error` or a swallowed failure.
    expect(ci).toContain('test "$CHANGED_PATHS_RESULT" = success')
    expect(ci).toContain('[ "$E2E_RESULT" = skipped ] && [ "$E2E_FILTER" = false ]')
    expect(ci).toContain('[ "$E2E_RESULT" = skipped ] && [ "$QUEUE_REUSE" = true ]')
    // Any e2e result that is neither `success` nor one of those two skips must
    // fall through to a hard failure -- there is no bare `= skipped`
    // acceptance any more.
    expect(ci).not.toContain('test "$E2E_RESULT" = success || test "$E2E_RESULT" = skipped')
    expect(ci).toContain(`e2e result '$E2E_RESULT' is not acceptable`)
    expect(ci).toMatch(/is not acceptable[^\n]*\n\s+exit 1/)
    // The merge-queue reuse probe is fail-closed in shape: it defaults to
    // false, only runs on merge_group, demands ALL 8 e2e shards succeeded on
    // the PR head (a path-filtered PR has nothing to reuse), and compares git
    // TREE shas, not commit shas.
    expect(ci).toContain("core.setOutput('reuse', 'false');")
    expect(ci).toContain("if: github.event_name == 'merge_group'")
    expect(ci).toContain('shards.length !== 8 || green.length !== 8')
    expect(ci).toContain('queueCommit.data.commit.tree.sha !== prCommit.data.commit.tree.sha')
    // Only the e2e lane is reuse-gated. Static analysis and the database lane
    // keep running in the queue as belt-and-braces on the exact tree.
    expect(ci).toContain(
      "if: needs.changed_paths.outputs.e2e == 'true' && needs.changed_paths.outputs.queue_reuse != 'true'"
    )
    expect(ci.match(/queue_reuse != 'true'/g)).toHaveLength(1)
    expect(ci).not.toContain('continue-on-error')
    expect(ci.toLowerCase()).not.toContain('codebuild-')
  })
})

describe('QB-CI-002 signed-in render lane', () => {
  const suiteDir = join(process.cwd(), 'apps', 'web', 'e2e', 'render', 'design-suite')
  const pin = JSON.parse(readFileSync(join(suiteDir, 'suite-pin.json'), 'utf8')) as {
    release: string
    files: { path: string; bytes: number; sha256: string }[]
  }

  function filesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]
    )
  }

  it('vendors the design suite checker byte for byte, exactly as pinned', () => {
    expect(pin.release).toBe('6.6.0')
    const present = filesUnder(suiteDir)
      .map((file) => relative(suiteDir, file))
      .filter((file) => file !== 'suite-pin.json')
      .sort()
    expect(present).toEqual(pin.files.map((file) => file.path).sort())
    for (const file of pin.files) {
      const bytes = readFileSync(join(suiteDir, file.path))
      expect(bytes.length, file.path).toBe(file.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256)
    }
  })

  it('runs as an advisory pull-request and manual lane beside the required gate', () => {
    const ci = readFileSync(join(workflowDir, 'ci.yml'), 'utf8')
    const job =
      ci.split('\n  signed_in_render:\n', 2)[1]?.split('\n  portability_gate:\n', 1)[0] ?? ''
    expect(job).toContain('name: Signed-in render check')
    expect(job).toContain(
      "if: github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && needs.changed_paths.outputs.render == 'true')"
    )
    expect(job).toContain('runs-on: ubuntu-latest')
    expect(job).toContain('timeout-minutes: 45')
    // The checker runs unmodified: the job refuses any bytes but the pinned ones.
    expect(job).toContain('sha256sum --check --strict')
    expect(job).toContain('bun run test:render')
    expect(job).toContain('bun e2e/render/run-checker.ts')
    expect(job).toContain('bun e2e/render/summarize.ts')
    expect(job).toContain('path: ${{ runner.temp }}/render')
    // It measures the production image built from this commit, never the dev
    // server or a host build that production does not run.
    expect(job).toContain('docker build --file apps/web/Dockerfile')
    expect(job).toContain('docker run --detach --name quackback-render --network host')
    // The path filter is fail-closed like the e2e one: every non-PR event and
    // any diff failure answers "run".
    expect(ci.match(/echo "render=true" >> "\$GITHUB_OUTPUT"/g)).toHaveLength(3)
    expect(ci).toContain("grep -E '^(apps/web/|\\.github/workflows/ci\\.yml$)'")
  })
})

describe('root dependency contract', () => {
  it('does not install the unused native image-processing stack', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    const lockfile = readFileSync(join(process.cwd(), 'bun.lock'), 'utf8')

    expect(packageJson.devDependencies?.sharp).toBeUndefined()
    expect(lockfile).not.toContain('"sharp": ["sharp@')
  })

  // Assert the SHAPE of the pins, never their current values. Spelling out
  // `oven/bun:1.3.14@sha256:e10577f0...` here made this test fail on every
  // Dependabot base-image bump by construction -- the update is correct and
  // the contract still holds, but the frozen literal disagrees. That turned a
  // routine bump into a recurring red build, and the images went unscanned.
  // What actually matters is preserved below: same registry, digest-pinned,
  // both stages on one Bun version, alpine runner, OpenSSL family explicitly
  // and consistently pinned.
  it('builds the production runner from patched, immutable Bun bases', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'apps', 'web', 'Dockerfile'), 'utf8')

    const base = dockerfile.match(/^FROM (oven\/bun:(\S+?))@(sha256:[0-9a-f]{64}) AS base$/m)
    const runner = dockerfile.match(
      /^FROM (oven\/bun:(\S+?)-alpine)@(sha256:[0-9a-f]{64}) AS runner$/m
    )

    expect(base, 'base stage must be a digest-pinned oven/bun image').not.toBeNull()
    expect(runner, 'runner stage must be a digest-pinned oven/bun alpine image').not.toBeNull()

    // Immutability is the digest, not the tag: a tag can be re-pointed.
    expect(base?.[3]).not.toEqual(runner?.[3])

    // Both stages must track one Bun version, or the runner executes a build
    // produced by a different toolchain than the one that compiled it.
    expect(runner?.[2]).toEqual(base?.[2])

    // The OpenSSL family is pinned to explicit alpine package revisions, and
    // to the SAME revision across all three -- a mismatched libssl3/libcrypto3
    // pair is the failure this pin exists to prevent.
    const opensslPins = ['libcrypto3', 'libssl3', 'openssl'].map((pkg) => {
      const found = dockerfile.match(new RegExp(`\\b${pkg}=(\\d+\\.\\d+\\.\\d+-r\\d+)`))
      expect(found, `${pkg} must be pinned to an explicit alpine revision`).not.toBeNull()
      return found?.[1]
    })
    expect(new Set(opensslPins).size, `OpenSSL pins disagree: ${opensslPins.join(', ')}`).toBe(1)
  })
})

// HYG-18: the runner stage inherited the Bun base image's OCI labels, so the
// deployed image claimed to be oven-sh/bun at Bun's revision and version.
// Assert the shape, never current values: every OCI key the base sets is
// overridden in the final stage, the build-specific ones come from build
// args, both image workflows pass those args, and the publish workflow reads
// the pushed labels back before any tag points at the image.
describe('image provenance labels', () => {
  const OCI_KEYS = [
    'title',
    'description',
    'licenses',
    'url',
    'source',
    'revision',
    'version',
    'created',
  ]
  const BUILD_ARG_LABELS: Array<[string, string]> = [
    ['url', 'SOURCE_REPOSITORY'],
    ['source', 'SOURCE_REPOSITORY'],
    ['revision', 'SOURCE_COMMIT'],
    ['version', 'IMAGE_VERSION'],
    ['created', 'SOURCE_CREATED'],
  ]

  it('overrides every base-image OCI label in the shipped stage', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'apps', 'web', 'Dockerfile'), 'utf8')
    const stages = [...dockerfile.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((match) => match[1])
    expect(stages[stages.length - 1], 'runner must be the final, shipped stage').toBe('runner')

    const runnerStage = dockerfile.split(/^FROM \S+ AS runner$/m)[1] ?? ''
    for (const key of OCI_KEYS) {
      expect(runnerStage, `runner stage must set org.opencontainers.image.${key}`).toMatch(
        new RegExp(`org\\.opencontainers\\.image\\.${key}=`)
      )
    }
    for (const [key, arg] of BUILD_ARG_LABELS) {
      expect(runnerStage, `runner stage must declare ARG ${arg}`).toMatch(
        new RegExp(`^ARG ${arg}=`, 'm')
      )
      expect(runnerStage, `${key} must come from ${arg}`).toContain(
        `org.opencontainers.image.${key}="\${${arg}}"`
      )
    }
  })

  it('passes the build values from both image workflows', () => {
    const publish = readFileSync(join(workflowDir, 'docker.yml'), 'utf8')
    const exported = readFileSync(join(workflowDir, 'export-amd64-image.yml'), 'utf8')
    for (const arg of new Set(BUILD_ARG_LABELS.map(([, name]) => name))) {
      expect(publish, `docker.yml must pass ${arg}`).toMatch(
        new RegExp(`^\\s+${arg}=\\$\\{\\{ `, 'm')
      )
      expect(exported, `export-amd64-image.yml must pass ${arg}`).toContain(
        `--build-arg "${arg}=`
      )
    }

    const verify = publish.indexOf('name: Verify per-arch provenance labels')
    const tag = publish.indexOf('name: Create manifest list and push')
    expect(verify, 'docker.yml must read the pushed labels back').toBeGreaterThan(-1)
    expect(verify, 'labels must be verified before any tag is applied').toBeLessThan(tag)
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
    // Was `toEqual([])`. The nightly full run is the one schedule this
    // repository declares; enumerate it exactly so a second one cannot be added
    // without also being declared here.
    expect(contract.schedules).toEqual([
      expect.objectContaining({
        name: 'ci-nightly-full-run',
        workflow: 'ci.yml',
        cadence: '17 5 * * *',
        execution_plane: 'github',
      }),
    ])
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

    // Every action in a dormant release workflow must be pinned to an immutable
    // 40-hex commit SHA; a floating tag can be re-pointed under us. Assert the
    // pin on every `uses:` rather than on three frozen SHA literals -- those
    // literals covered only 3 of the 11 actions in these two files, and turned
    // every legitimate action bump into a CI failure (PR #35).
    const unpinned: string[] = []
    let auditedActions = 0
    for (const [name, workflow] of [
      ['publish-widget.yml', widget],
      ['release-openapi.yml', openapi],
    ] as const) {
      for (const line of workflow.split('\n')) {
        if (!/^\s*(-\s*)?uses:/.test(line)) continue
        auditedActions += 1
        const ref = line.split('uses:')[1].split('#')[0].trim().split('@')[1] ?? ''
        if (!/^[0-9a-f]{40}$/.test(ref)) unpinned.push(`${name}: ${line.trim()}`)
      }
    }
    expect(unpinned).toEqual([])
    expect(auditedActions).toBeGreaterThanOrEqual(11)
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

    // REQ-21: the ledger is enforced in the required lane, on full history.
    const ci = readFileSync(join(workflowDir, 'ci.yml'), 'utf8')
    const staticAnalysis = ci.split('\n  static_analysis:\n')[1]?.split('\n  database_tests:\n')[0]
    expect(staticAnalysis).toContain('fetch-depth: 0')
    expect(staticAnalysis).toContain('run: bun scripts/check-upstream-intake-ledger.ts')
  })
})

describe('QB-CI-002 e2e shard balance contract', () => {
  const ci = readFileSync(join(workflowDir, 'ci.yml'), 'utf8')

  function weights(): number[] {
    // Quote style belongs to prettier, so match either rather than fight it.
    const match = ci.match(/PWTEST_SHARD_WEIGHTS:\s*['"]([0-9:]+)['"]/)
    expect(match, 'ci.yml must declare PWTEST_SHARD_WEIGHTS').not.toBeNull()
    return match![1].split(':').map(Number)
  }

  it('declares one weight per shard, and every weight is usable', () => {
    // Playwright throws when the count does not match the shard total, so a
    // mismatch here is a red lane rather than a silent fallback.
    const shardLine = ci.match(/shard:\s*\[([0-9,\s]+)\]/)
    expect(shardLine).not.toBeNull()
    const shardCount = shardLine![1].split(',').length
    const w = weights()
    expect(w).toHaveLength(shardCount)

    // filterForShard computes floor(weight * total / sum). A weight small
    // enough to floor to zero hands a shard no tests, and an empty shard
    // proves nothing -- so keep every weight a meaningful share.
    expect(w.every((n) => Number.isInteger(n) && n > 0)).toBe(true)
    const sum = w.reduce((a, b) => a + b, 0)
    for (const n of w) {
      expect(
        Math.floor((n * sum) / sum),
        `weight ${n} must not floor to an empty shard`
      ).toBeGreaterThan(0)
    }
  })

  it('sets the weights once, at job level, so the plan and the run agree', () => {
    // The plan step (--list) and the run step must partition identically. If
    // only one saw the weights, the shard's results would not match its own
    // plan and check-known-failures.ts would fail it. Declaring the value once
    // on the job is what makes that impossible rather than merely unlikely.
    expect(ci.match(/^\s*PWTEST_SHARD_WEIGHTS:\s*['"]/gm)).toHaveLength(1)

    const e2eJob = ci.slice(ci.indexOf('\n  e2e_tests:'))
    const jobEnv = e2eJob.slice(e2eJob.indexOf('\n    env:'), e2eJob.indexOf('\n    steps:'))
    expect(jobEnv).toContain('PWTEST_SHARD_WEIGHTS:')

    // Both consumers still shard, and neither carries its own override.
    expect(e2eJob).toContain('--list --reporter=json --shard=${{ matrix.shard }}/8')
    expect(e2eJob).toContain('bun run test:e2e -- --shard=${{ matrix.shard }}/8')
  })

  it('keeps the regeneration path in the repository, not in a commit message', () => {
    // A tuned constant with no way to retune it rots into a number nobody
    // dares touch. The script is the documented way back to a fresh vector.
    const script = join(process.cwd(), 'apps', 'web', 'e2e', 'scripts', 'compute-shard-weights.ts')
    expect(existsSync(script)).toBe(true)
    const source = readFileSync(script, 'utf8')
    expect(source).toContain('PWTEST_SHARD_WEIGHTS')
    // It must refuse to emit a vector that would empty a shard.
    expect(source).toContain('refusing to emit it')
    expect(ci).toContain('compute-shard-weights.ts')
  })

  it('records that reweighting moves boundaries and cannot change what runs', () => {
    // The safety argument, kept next to the constant it justifies: weights
    // only move cut points, and filterForShard assigns every group to exactly
    // one shard for any vector. Verified against Playwright 1.62.1 -- the
    // union of all 8 shards is identical with and without these weights
    // (803 distinct tests either way).
    expect(ci).toContain('exactly one shard for ANY weight vector')
    expect(ci).toContain('803 distinct tests either way')
  })
})

describe('QB-CI-003 database setup steps fail fast', () => {
  const ci = readFileSync(join(workflowDir, 'ci.yml'), 'utf8')

  /** The text of one job, from its key up to the next job's key. */
  function job(name: string): string {
    const body = ci.split(`\n  ${name}:\n`)[1]
    expect(body, `ci.yml must declare the ${name} job`).toBeDefined()
    return body!.split(/\n {2}[a-z0-9_-]+:\n/)[0]
  }

  /** The text of the step in `jobText` whose run line is exactly `command`. */
  function step(jobText: string, command: string): string | undefined {
    const steps = jobText.split('\n    steps:\n')[1]?.split(/\n {6}- /) ?? []
    return steps.find((text) => text.split('\n').some((line) => line.trim() === `run: ${command}`))
  }

  // A hung `bun run db:migrate` on run 35980940017 (shard 8, attempt 1) held
  // its runner for an hour, because only the job cap applied. Every step that
  // sets up the database container carries its own, much smaller cap.
  it.each([
    ['database_tests', ['bun run db:migrate', 'bun run db:indexes']],
    ['e2e_tests', ['bun run db:migrate', 'bun run db:seed']],
  ] as const)('%s caps each database setup step on its own', (name, commands) => {
    const text = job(name)
    const jobCap = Number(text.match(/\n {4}timeout-minutes: (\d+)\n/)?.[1])
    expect(jobCap).toBeGreaterThan(0)
    for (const command of commands) {
      const found = step(text, command)
      expect(found, `${name} must run ${command}`).toBeDefined()
      const cap = Number(found!.match(/(?:^|\n) {8}timeout-minutes: (\d+)(?:\n|$)/)?.[1])
      expect(cap, `${name}: ${command} needs its own timeout-minutes`).toBeGreaterThan(0)
      expect(cap).toBeLessThanOrEqual(10)
      expect(cap).toBeLessThan(jobCap)
    }
  })
})
