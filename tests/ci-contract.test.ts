import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
