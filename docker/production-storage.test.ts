import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const compose = readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8')
const temporaryDirectories: string[] = []

// Execute the production initializer's shell body, retaining Compose's quoting
// while resolving its escaped container variables. The command double stands
// in for MinIO so failure and inherited-policy cases need no real credentials.
function initializerScript() {
  const match = compose.match(
    /^ {2}minio-init:[\s\S]*?^ {4}entrypoint: >\n {6}\/bin\/sh -c "\n([\s\S]*?)\n {6}"/m
  )
  if (!match) throw new Error('Production MinIO initializer was not found')
  return match[1].replaceAll('\\"', '"').replaceAll('$$', '$')
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'quackback-private-storage-'))
  temporaryDirectories.push(directory)
  const grant = join(directory, 'grant')
  const calls = join(directory, 'calls')
  writeFileSync(grant, 'anonymous')
  writeFileSync(calls, '')
  writeFileSync(
    join(directory, 'mc'),
    `#!/bin/sh
set -eu
case "$1:$2" in
  alias:set)
    printf 'alias\\n' >> "$CALLS"
    test "$3" = local
    test "$4" = http://minio:9000
    test "$5" = "$MINIO_ROOT_USER"
    test "$6" = "$MINIO_ROOT_PASSWORD"
    test "$FAIL_AT" != alias
    ;;
  mb:--ignore-existing)
    printf 'bucket\\n' >> "$CALLS"
    test "$3" = "local/$S3_BUCKET"
    test "$FAIL_AT" != bucket
    ;;
  anonymous:set)
    printf 'policy\\n' >> "$CALLS"
    test "$3" = none
    test "$4" = "local/$S3_BUCKET"
    test "$FAIL_AT" != policy
    printf private > "$GRANT"
    ;;
  *) exit 80 ;;
esac
`,
    { mode: 0o700 }
  )
  return {
    grant,
    calls,
    run(failAt = '') {
      return spawnSync('/bin/sh', ['-c', initializerScript()], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          PATH: directory + ':' + process.env.PATH,
          CALLS: calls,
          GRANT: grant,
          FAIL_AT: failAt,
          MINIO_ROOT_USER: 'fixture-access',
          MINIO_ROOT_PASSWORD: 'fixture secret $with punctuation',
          S3_BUCKET: 'fixture-attachments',
        },
      })
    },
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    for (const name of ['mc', 'grant', 'calls']) unlinkSync(join(directory, name))
    rmdirSync(directory)
  }
})

describe('FB-019: production bucket admission', () => {
  it('revokes an inherited anonymous grant on the first and repeated initialization', () => {
    const storage = fixture()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = storage.run()
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(storage.grant, 'utf8')).toBe('private')
      expect(result.stdout + result.stderr).not.toContain('fixture secret')
    }
    expect(readFileSync(storage.calls, 'utf8').trim().split('\n')).toEqual([
      'alias',
      'bucket',
      'policy',
      'alias',
      'bucket',
      'policy',
    ])
  })

  it.each([
    ['alias', ['alias']],
    ['bucket', ['alias', 'bucket']],
    ['policy', ['alias', 'bucket', 'policy']],
  ])('fails closed when %s fails and never continues past that step', (step, calls) => {
    const storage = fixture()
    const result = storage.run(step as string)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(readFileSync(storage.grant, 'utf8')).toBe('anonymous')
    expect(readFileSync(storage.calls, 'utf8').trim().split('\n')).toEqual(calls)
    expect(result.stdout + result.stderr).not.toContain('fixture secret')
  })
})
