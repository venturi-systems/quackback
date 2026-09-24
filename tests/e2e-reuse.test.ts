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
    'Collect the expected tests for this shard',
    'Run the Playwright suite',
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
  return {
    run,
    jobs,
    receipts,
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
  }
}

async function probe(f = fixture()) {
  const outputs: Record<string, string> = {}
  const archives = f.receipts.map((receipt) =>
    execFileSync(
      'python3',
      [
        '-c',
        'import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("tested-tree.json",sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())',
      ],
      { input: f.badJson ? '{invalid' : JSON.stringify(receipt) }
    )
  )
  const artifacts = archives.map((bytes, i) => ({
    id: i + 100,
    name: `e2e-tested-tree-${f.run.id}-${f.run.run_attempt}-${i + 1}`,
    expired: f.expired,
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
    'Run the Playwright suite',
    'Check the shard against the known-failure ratchet',
    'Verify the tested checkout is unchanged',
  ])('rejects skipped %s', async (name) => {
    const f = fixture()
    f.jobs[0].steps.find((step) => step.name === name)!.conclusion = 'skipped'
    expect((await probe(f)).reuse).toBe('false')
  })
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
      const check = (commit: string, tree: string, dirty = false) => {
        writeFileSync(
          join(dir, 'git'),
          `#!/bin/sh
case "$2" in
HEAD) echo '${commit}' ;;
'HEAD^{tree}') echo '${tree}' ;;
--exit-code) exit ${dirty ? 1 : 0} ;;
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
      expect(check(testedMerge, testedTree).status).toBe(0)
      expect(check(prHead, testedTree).status).not.toBe(0)
      expect(check(testedMerge, otherTree).status).not.toBe(0)
      expect(check(testedMerge, testedTree, true).status).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('records the checkout before tests and uploads only after the ratchet passes', () => {
    const e2e = workflow.split('\n  e2e_tests:')[1].split('\n  portability_gate:')[0]
    expect(e2e.indexOf('name: Record the actual tested checkout')).toBeLessThan(
      e2e.indexOf('bun install')
    )
    expect(e2e.indexOf('name: Upload tested checkout evidence')).toBeGreaterThan(
      e2e.indexOf('name: Check the shard against the known-failure ratchet')
    )
    expect(e2e).toContain("['git', 'rev-parse', 'HEAD^{tree}']")
    expect(e2e).toContain("if: github.event_name == 'pull_request'")
  })
})
