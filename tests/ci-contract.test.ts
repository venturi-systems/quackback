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
