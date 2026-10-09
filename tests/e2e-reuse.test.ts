import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const localRequire = createRequire(import.meta.url)
const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
const block = workflow.split(
  '      - name: Reuse exact-tree PR evidence for a merge-queue entry'
)[1]
const script = block
  .split('          script: |\n')[1]
  .split('\n  e2e_tests:')[0]
  .split('\n')
  .map((line) => line.slice(12))
  .join('\n')
const execute = new Function(
  'github',
  'context',
  'core',
  'require',
  'process',
  'return (async () => {\n' + script + '\n})()'
)
const prHead = 'a'.repeat(40)
const testedMerge = 'b'.repeat(40)
const testedTree = 'c'.repeat(40)
const queueHead = 'd'.repeat(40)
const otherTree = 'e'.repeat(40)

function fixture() {
  const run = { id: 123, run_attempt: 2, head_sha: prHead, conclusion: 'success' }
  const requiredSteps = [
    'Checkout tested source',
    'Record the actual tested checkout',
    'Build exact E2E application image',
    'Start attested E2E application image',
    'Collect the expected tests for this shard',
    'Run the Playwright suite',
    'Capture and stop owned E2E application',
    'Upload E2E application evidence',
    'Check the shard against the known-failure ratchet',
    'Verify the tested checkout is unchanged',
    'Upload tested checkout evidence',
  ]
  const jobs = Array.from({ length: 8 }, (_, i) => ({
    name: `End-to-end tests (shard ${i + 1} of 8)`,
    steps: requiredSteps.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    status: 'completed',
    conclusion: 'success',
  }))
  const receipts = Array.from({ length: 8 }, (_, i) => ({
    schema: 1,
    run_id: run.id,
    run_attempt: run.run_attempt,
    shard: i + 1,
    event: 'pull_request',
    pr_head: prHead,
    commit: testedMerge,
    tree: testedTree,
  }))
  const imageIdentity = receipts.map((receipt, index) => ({
    schema: receipt.schema,
    run_id: receipt.run_id,
    run_attempt: receipt.run_attempt,
    shard: receipt.shard,
    commit: receipt.commit,
    tree: receipt.tree,
    image_id: 'sha256:' + '1'.repeat(64),
    container_id: (index + 1).toString(16).repeat(64),
    fixture_receipt: 'DESIGN_FIXTURE_ENVIRONMENT_OK:' + (index + 1).toString(16).repeat(64),
    mode: 'development',
  }))
  const imageReady: Array<Record<string, unknown>> = imageIdentity.map((identity) => ({
    ...identity,
    ready: true,
    inspected_before_start: true,
    runtime_development_mode_verified: true,
    process_identity: { pid: 1234, started_at: '2026-10-03T00:09:37.123456789Z', restart_count: 0 },
    process_continuity_verified: true,
    development_mode_probe: { requests: 4, elapsed_ms: 250, origin_rejected: true },
  }))
  const imageAfter: Array<Record<string, unknown>> = imageIdentity.map((identity) => ({
    ...identity,
    configuration_verified: true,
    source_unchanged: true,
    running_before_stop: true,
    stopped: true,
  }))
  return {
    run,
    jobs,
    receipts,
    imageReady,
    imageAfter,
    queueTree: testedTree,
    commitTree: testedTree,
    parents: [{ sha: prHead }],
    corruptDigest: false,
    expired: false,
    omit: false,
    duplicate: false,
    badJson: false,
    wrongProducer: false,
    failDownload: false,
    omitImageReady: false,
    omitImageAfter: false,
    badImageReadyJson: false,
    badImageAfterJson: false,
    oversizedEvidence: false,
    invalidSize: false,
  }
}

async function probe(f = fixture()) {
  const outputs: Record<string, string> = {}
  const archiveFiles = f.receipts.map((receipt, index) => {
    const files: Record<string, string> = {
      'tested-tree.json': f.badJson ? '{invalid' : JSON.stringify(receipt),
    }
    if (!f.omitImageReady) {
      files['image-server-ready.json'] = f.badImageReadyJson
        ? '{invalid'
        : JSON.stringify(f.imageReady[index])
    }
    if (!f.omitImageAfter) {
      files['image-server-after.json'] = f.badImageAfterJson
        ? '{invalid'
        : JSON.stringify(f.imageAfter[index])
    }
    return files
  })
  // Build the same eight independent ZIPs in one process. Starting Python for
  // every shard dominates these repeated negative cases under shared CI load;
  // batching removes startup work without changing evidence or its assertions.
  const encodedArchives = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        [
          'import base64, io, json, sys, zipfile',
          'archives = []',
          'for files in json.load(sys.stdin):',
          '    buffer = io.BytesIO()',
          '    with zipfile.ZipFile(buffer, "w") as archive:',
          '        for name, data in files.items():',
          '            archive.writestr(name, data)',
          '    archives.append(base64.b64encode(buffer.getvalue()).decode("ascii"))',
          'json.dump(archives, sys.stdout)',
        ].join('\n'),
      ],
      { input: JSON.stringify(archiveFiles), encoding: 'utf8' }
    )
  ) as string[]
  const archives = encodedArchives.map((encoded) => Buffer.from(encoded, 'base64'))
  const artifacts = archives.map((bytes, i) => ({
    id: i + 100,
    name: `e2e-tested-tree-${f.run.id}-${f.run.run_attempt}-${i + 1}`,
    expired: f.expired,
    size_in_bytes: f.invalidSize ? Number.NaN : f.oversizedEvidence ? 65537 : bytes.length,
    workflow_run: { id: f.wrongProducer ? 999 : f.run.id, head_sha: prHead },
    digest:
      'sha256:' +
      (f.corruptDigest ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')),
  }))
  if (f.omit) artifacts.pop()
  if (f.duplicate) artifacts[7] = { ...artifacts[0], id: 107 }
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: prHead } } }) },
      actions: {
        listWorkflowRuns: 'runs',
        listJobsForWorkflowRun: 'jobs',
        listWorkflowRunArtifacts: 'artifacts',
        downloadArtifact: async ({ artifact_id }: { artifact_id: number }) => {
          if (f.failDownload) throw new Error('upstream unavailable')
          return { data: archives[artifact_id - 100] }
        },
      },
      repos: {
        getCommit: async ({ ref }: { ref: string }) => ({
          data: {
            commit: { tree: { sha: ref === queueHead ? f.queueTree : f.commitTree } },
            parents: f.parents,
          },
        }),
      },
    },
    paginate: async (endpoint: string) =>
      endpoint === 'runs' ? [f.run] : endpoint === 'jobs' ? f.jobs : artifacts,
  }
  await execute(
    github,
    {
      repo: { owner: 'venturi-systems', repo: 'quackback' },
      payload: {
        merge_group: {
          head_sha: queueHead,
          head_ref: 'refs/heads/gh-readonly-queue/main/pr-129-test',
        },
      },
    },
    {
      setOutput: (key: string, value: string) => {
        outputs[key] = value
      },
      info: () => {},
    },
    localRequire,
    { env: { GITHUB_WORKFLOW_REF: 'venturi-systems/quackback/.github/workflows/ci.yml@main' } }
  )
  return outputs
}

describe('merge queue reuse checks the checkout that actually ran', () => {
  it('reuses eight digest-verified receipts for the tested synthetic merge tree', async () => {
    expect((await probe()).reuse).toBe('true')
  })
  it('does not reuse a queue matching only the untested PR-head tree', async () => {
    const f = fixture()
    f.queueTree = otherTree
    expect((await probe(f)).reuse).toBe('false')
  })
  it.each([
    'corruptDigest',
    'expired',
    'omit',
    'duplicate',
    'badJson',
    'wrongProducer',
    'failDownload',
    'omitImageReady',
    'omitImageAfter',
    'badImageReadyJson',
    'badImageAfterJson',
    'oversizedEvidence',
    'invalidSize',
  ] as const)('fails closed for %s evidence', async (field) => {
    const f = fixture()
    f[field] = true
    expect((await probe(f)).reuse).toBe('false')
  })
  it('rejects receipts from an earlier attempt', async () => {
    const f = fixture()
    f.receipts[3].run_attempt = 1
    expect((await probe(f)).reuse).toBe('false')
  })
  it('rejects divergent shard checkouts', async () => {
    const f = fixture()
    f.receipts[3].commit = 'f'.repeat(40)
    expect((await probe(f)).reuse).toBe('false')
  })
  it('requires the recorded commit to really have the recorded tree', async () => {
    const f = fixture()
    f.commitTree = otherTree
    expect((await probe(f)).reuse).toBe('false')
  })
  it('requires the tested merge to contain the PR head', async () => {
    const f = fixture()
    f.parents = [{ sha: 'f'.repeat(40) }]
    expect((await probe(f)).reuse).toBe('false')
  })
  it('rejects a skipped shard and duplicate shard names', async () => {
    const f = fixture()
    f.jobs[0].conclusion = 'skipped'
    expect((await probe(f)).reuse).toBe('false')
    f.jobs[0].conclusion = 'success'
    f.jobs[7].name = f.jobs[0].name
    expect((await probe(f)).reuse).toBe('false')
  })
  it.each([
    'Build exact E2E application image',
    'Start attested E2E application image',
    'Run the Playwright suite',
    'Capture and stop owned E2E application',
    'Upload E2E application evidence',
    'Check the shard against the known-failure ratchet',
    'Verify the tested checkout is unchanged',
  ])('rejects unsuccessful %s even with retained receipts', async (name) => {
    for (const conclusion of ['skipped', 'failure', 'cancelled']) {
      const f = fixture()
      f.jobs[0].steps.find((step) => step.name === name)!.conclusion = conclusion
      expect((await probe(f)).reuse).toBe('false')
    }
  })
  it.each([
    'Build exact E2E application image',
    'Start attested E2E application image',
    'Capture and stop owned E2E application',
    'Upload E2E application evidence',
  ])('rejects missing, duplicate or unfinished %s', async (name) => {
    const absent = fixture()
    absent.jobs[0].steps = absent.jobs[0].steps.filter((step) => step.name !== name)
    expect((await probe(absent)).reuse).toBe('false')
    const duplicate = fixture()
    duplicate.jobs[0].steps.push({ name, status: 'completed', conclusion: 'success' })
    expect((await probe(duplicate)).reuse).toBe('false')
    const unfinished = fixture()
    unfinished.jobs[0].steps.find((step) => step.name === name)!.status = 'in_progress'
    expect((await probe(unfinished)).reuse).toBe('false')
  })

  it.each(['schema', 'run_id', 'run_attempt', 'shard', 'commit', 'tree'] as const)(
    'binds matching image receipts to the tested checkout field %s',
    async (field) => {
      const f = fixture()
      const current = f.imageReady[3][field]
      const forged = typeof current === 'number' ? current + 1 : '9'.repeat(40)
      f.imageReady[3][field] = forged
      f.imageAfter[3][field] = forged
      expect((await probe(f)).reuse).toBe('false')
    }
  )

  it.each([
    'image_id',
    'container_id',
    'fixture_receipt',
    'mode',
    'ready',
    'inspected_before_start',
    'runtime_development_mode_verified',
    'process_identity',
    'process_continuity_verified',
    'development_mode_probe',
  ])('rejects missing image readiness field %s', async (field) => {
    const f = fixture()
    delete f.imageReady[3][field]
    expect((await probe(f)).reuse).toBe('false')
  })

  it.each([
    ['image_id', 'sha256:' + 'a'.repeat(63)],
    ['image_id', 'sha256:' + 'A'.repeat(64)],
    ['image_id', ['sha256:' + '1'.repeat(64)]],
    ['container_id', 'a'.repeat(63)],
    ['container_id', ['a'.repeat(64)]],
    ['fixture_receipt', 'DESIGN_FIXTURE_ENVIRONMENT_OK:' + 'g'.repeat(64)],
    ['fixture_receipt', ['DESIGN_FIXTURE_ENVIRONMENT_OK:' + '1'.repeat(64)]],
    ['mode', 'production'],
    ['mode', 'test'],
    ['ready', false],
    ['ready', 'true'],
    ['inspected_before_start', false],
    ['runtime_development_mode_verified', false],
    ['runtime_development_mode_verified', 'true'],
    ['process_continuity_verified', false],
    ['process_continuity_verified', 'true'],
    ['process_continuity_verified', 1],
    ['process_continuity_verified', null],
  ] as const)('rejects malformed image readiness %s: %j', async (field, value) => {
    const f = fixture()
    f.imageReady[3][field] = value
    expect((await probe(f)).reuse).toBe('false')
  })

  it.each([
    { identity: null },
    { identity: [] },
    { identity: 'process' },
    { identity: 1234 },
    { identity: {} },
  ])('rejects missing process identity members: $identity', async ({ identity }) => {
    const f = fixture()
    f.imageReady[3].process_identity = identity
    expect((await probe(f)).reuse).toBe('false')
  })

  it.each(['pid', 'started_at', 'restart_count'])(
    'requires process identity member %s',
    async (field) => {
      const f = fixture()
      delete (f.imageReady[3].process_identity as Record<string, unknown>)[field]
      expect((await probe(f)).reuse).toBe('false')
    }
  )

  it.each([
    ['pid', 0],
    ['pid', -1],
    ['pid', 1.5],
    ['pid', '1234'],
    ['pid', true],
    ['pid', null],
    ['pid', Number.MAX_SAFE_INTEGER + 1],
    ['restart_count', -1],
    ['restart_count', 0.5],
    ['restart_count', '0'],
    ['restart_count', false],
    ['restart_count', null],
    ['restart_count', Number.MAX_SAFE_INTEGER + 1],
    ['started_at', null],
    ['started_at', 1790986177000],
    ['started_at', ''],
    ['started_at', 'not-a-date'],
    ['started_at', '0001-01-01T00:00:00Z'],
    ['started_at', '0001-01-01T00:00:00.000000000Z'],
    ['started_at', '2026-10-03'],
    ['started_at', '2026-10-03T00:09:37'],
    ['started_at', '2026-10-03T00:09:37+00:00'],
    ['started_at', '2026-10-03T00:09:37.1234567890Z'],
    ['started_at', '2026-02-30T00:09:37Z'],
    ['started_at', '2026-10-03T24:00:00Z'],
    ['started_at', '2026-13-03T00:09:37Z'],
  ] as const)('rejects malformed process identity %s: %j', async (field, value) => {
    const f = fixture()
    const identity = f.imageReady[3].process_identity as Record<string, unknown>
    identity[field] = value
    expect((await probe(f)).reuse).toBe('false')
  })

  it.each([
    '2026-10-03T00:09:37Z',
    '2026-10-03T00:09:37.1Z',
    '2026-10-03T00:09:37.123Z',
    '2026-10-03T00:09:37.123456789Z',
    '2024-02-29T00:09:37Z',
  ])('accepts valid Docker process start timestamps: %s', async (startedAt) => {
    const f = fixture()
    f.imageReady[3].process_identity = { pid: 1, started_at: startedAt, restart_count: 2 }
    expect((await probe(f)).reuse).toBe('true')
  })

  it.each([
    { requests: 3, elapsed_ms: 250, origin_rejected: true },
    { requests: 5, elapsed_ms: 250, origin_rejected: true },
    { requests: '4', elapsed_ms: 250, origin_rejected: true },
    { elapsed_ms: 250, origin_rejected: true },
    { requests: 4, origin_rejected: true },
    { requests: 4, elapsed_ms: -1, origin_rejected: true },
    { requests: 4, elapsed_ms: 60000, origin_rejected: true },
    { requests: 4, elapsed_ms: 60001, origin_rejected: true },
    { requests: 4, elapsed_ms: Number.NaN, origin_rejected: true },
    { requests: 4, elapsed_ms: Number.POSITIVE_INFINITY, origin_rejected: true },
    { requests: 4, elapsed_ms: null, origin_rejected: true },
    { requests: 4, elapsed_ms: '250', origin_rejected: true },
    { requests: 4, elapsed_ms: 250 },
    { requests: 4, elapsed_ms: 250, origin_rejected: false },
    { requests: 4, elapsed_ms: 250, origin_rejected: 'true' },
  ])('rejects incomplete or out-of-window runtime development-mode proof: %j', async (proof) => {
    const f = fixture()
    f.imageReady[3].development_mode_probe = proof
    expect((await probe(f)).reuse).toBe('false')
  })

  it.each([0, 59999.999])(
    'accepts complete development-mode proof within the window: %s',
    async (elapsed) => {
      const f = fixture()
      f.imageReady[3].development_mode_probe = {
        requests: 4,
        elapsed_ms: elapsed,
        origin_rejected: true,
      }
      expect((await probe(f)).reuse).toBe('true')
    }
  )

  it('allows independently built shard images when each lifecycle identity matches', async () => {
    const f = fixture()
    f.imageReady[3].image_id = 'sha256:' + '9'.repeat(64)
    f.imageAfter[3].image_id = f.imageReady[3].image_id
    expect((await probe(f)).reuse).toBe('true')
  })

  it.each(['production', 'test'])(
    'rejects matching %s-mode receipts despite a claimed development-mode probe',
    async (mode) => {
      const f = fixture()
      f.imageReady[3].mode = mode
      f.imageAfter[3].mode = mode
      expect((await probe(f)).reuse).toBe('false')
    }
  )

  it.each([
    'schema',
    'run_id',
    'run_attempt',
    'shard',
    'commit',
    'tree',
    'image_id',
    'container_id',
    'fixture_receipt',
    'mode',
  ])('rejects changed or missing shutdown identity %s', async (field) => {
    const changed = fixture()
    const replacements: Record<string, unknown> = {
      schema: 2,
      run_id: 124,
      run_attempt: 3,
      shard: 5,
      commit: '9'.repeat(40),
      tree: '9'.repeat(40),
      image_id: 'sha256:' + '9'.repeat(64),
      container_id: '9'.repeat(64),
      fixture_receipt: 'DESIGN_FIXTURE_ENVIRONMENT_OK:' + '9'.repeat(64),
      mode: 'production',
    }
    changed.imageAfter[3][field] = replacements[field]
    expect((await probe(changed)).reuse).toBe('false')
    const missing = fixture()
    delete missing.imageAfter[3][field]
    expect((await probe(missing)).reuse).toBe('false')
  })

  it.each(['configuration_verified', 'source_unchanged', 'running_before_stop', 'stopped'])(
    'requires actual shutdown attestation %s',
    async (field) => {
      for (const value of [false, 'true', 1, null, undefined]) {
        const f = fixture()
        if (value === undefined) delete f.imageAfter[3][field]
        else f.imageAfter[3][field] = value
        expect((await probe(f)).reuse).toBe('false')
      }
    }
  )

  it('rejects a setup-only successful shard', async () => {
    const f = fixture()
    f.jobs[0].steps = f.jobs[0].steps.slice(0, 2)
    expect((await probe(f)).reuse).toBe('false')
  })
  it('executes the producer guard and refuses a checkout changed before upload', () => {
    const step = workflow
      .split('      - name: Verify the tested checkout is unchanged')[1]
      .split('      - name: Upload tested checkout evidence')[0]
    const python = step
      .split("python3 - <<'PYTHON'\n")[1]
      .split('          PYTHON')[0]
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n')
    const dir = mkdtempSync(join(tmpdir(), 'e2e-producer-test-'))
    try {
      mkdirSync(join(dir, 'e2e-evidence'))
      writeFileSync(
        join(dir, 'e2e-evidence/tested-tree.json'),
        JSON.stringify({
          commit: testedMerge,
          tree: testedTree,
        })
      )
      const check = (commit: string, tree: string, diffExit = 0) => {
        writeFileSync(
          join(dir, 'git'),
          `#!/bin/sh
case "$2" in
HEAD) echo '${commit}' ;;
'HEAD^{tree}') echo '${tree}' ;;
--exit-code) exit ${diffExit} ;;
*) exit 2 ;;
esac
`,
          { mode: 0o755 }
        )
        return spawnSync('python3', ['-c', python], {
          encoding: 'utf8',
          env: { ...process.env, RUNNER_TEMP: dir, PATH: dir + ':' + process.env.PATH },
        })
      }
      const before = readFileSync(join(dir, 'e2e-evidence/tested-tree.json'), 'utf8')
      for (const [commit, tree, diffExit, unchanged] of [
        [testedMerge, testedTree, 0, true],
        [prHead, testedTree, 0, false],
        [testedMerge, otherTree, 0, false],
        [testedMerge, testedTree, 1, false],
        [testedMerge, testedTree, 128, false],
      ] as const) {
        const result = check(commit, tree, diffExit)
        expect(result.status, result.stderr).toBe(unchanged ? 0 : 1)
        expect(
          JSON.parse(readFileSync(join(dir, 'e2e-evidence/tested-tree-after.json'), 'utf8'))
        ).toEqual({
          commit,
          tree,
          tracked_diff_exit: diffExit,
          unchanged,
        })
        expect(readFileSync(join(dir, 'e2e-evidence/tested-tree.json'), 'utf8')).toBe(before)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('retains before and after checkout evidence after a failed ratchet', () => {
    const e2e = workflow.split('\n  e2e_tests:')[1].split('\n  portability_gate:')[0]
    expect(e2e.indexOf('name: Record the actual tested checkout')).toBeLessThan(
      e2e.indexOf('bun install')
    )
    expect(e2e.indexOf('name: Upload tested checkout evidence')).toBeGreaterThan(
      e2e.indexOf('name: Check the shard against the known-failure ratchet')
    )
    expect(e2e).toContain("['git', 'rev-parse', 'HEAD^{tree}']")
    const record = e2e
      .split('      - name: Record the actual tested checkout')[1]
      .split('      - uses:')[0]
    const verify = e2e
      .split('      - name: Verify the tested checkout is unchanged')[1]
      .split('      - name: Upload tested checkout evidence')[0]
    const upload = e2e
      .split('      - name: Upload tested checkout evidence')[1]
      .split(/\n {6}- /, 1)[0]
    expect(record).toContain('id: tested_checkout')
    expect(verify).toContain("if: ${{ always() && steps.tested_checkout.outcome == 'success' }}")
    expect(upload).toContain(
      "if: ${{ always() && github.event_name == 'pull_request' && steps.tested_checkout.outcome == 'success' }}"
    )
    expect(upload).toContain('path: |')
    for (const name of [
      'tested-tree*.json',
      'image-server-ready.json',
      'image-server-after.json',
    ]) {
      expect(upload).toContain('${{ runner.temp }}/e2e-evidence/' + name)
    }
    expect(upload).not.toMatch(/image-server-build\.log|image-server\*|inspect/)
    expect(upload).toContain('if-no-files-found: error')
  })
})
