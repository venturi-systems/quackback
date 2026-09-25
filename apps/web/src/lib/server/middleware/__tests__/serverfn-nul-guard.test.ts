/**
 * Tests for the server-function NUL guard (DEF-45).
 *
 * Postgres cannot store a NUL character in text or jsonb, so a server-function
 * input holding one would fail its query. The guard runs as a global function
 * middleware and refuses such a call before the function's own validator.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  NUL_INPUT_MESSAGE,
  findNulPath,
  nulInputError,
  serverFnNulGuard,
} from '../serverfn-nul-guard'

const NUL = '\u0000'

describe('findNulPath', () => {
  it.each<[label: string, input: unknown]>([
    ['no input', undefined],
    ['null', null],
    ['an empty object', {}],
    ['plain text', 'Dark mode'],
    ['numbers and booleans', { limit: 20, offset: 0, unreadOnly: true }],
    [
      'nested objects and arrays',
      { postId: 'post_01', tagIds: ['tag_01', 'tag_02'], filters: { search: 'dark mode' } },
    ],
    ['a Date', { dateFrom: new Date('2026-01-01T00:00:00Z') }],
    ['a Map and a Set', { m: new Map([['k', 'v']]), s: new Set(['a', 'b']) }],
  ])('finds nothing in %s', (_label, input) => {
    expect(findNulPath(input)).toBeNull()
  })

  it('reports the path of a string value holding a NUL', () => {
    expect(findNulPath(`dark${NUL}mode`)).toEqual([])
    expect(findNulPath({ search: `dark${NUL}` })).toEqual(['search'])
    expect(findNulPath({ filters: { tagIds: ['ok', `t${NUL}`] } })).toEqual([
      'filters',
      'tagIds',
      1,
    ])
  })

  it('reports an object key holding a NUL at the path of its object', () => {
    expect(findNulPath({ metadata: { [`pl${NUL}an`]: 'pro' } })).toEqual(['metadata'])
  })

  it('walks Map, Set and FormData string entries', () => {
    expect(findNulPath({ m: new Map([['k', `v${NUL}`]]) })).toEqual(['m', 'k'])
    expect(findNulPath({ m: new Map([[`k${NUL}`, 'v']]) })).toEqual(['m'])
    expect(findNulPath({ s: new Set(['a', `b${NUL}`]) })).toEqual(['s', 1])

    const form = new FormData()
    form.append('name', 'logo')
    form.append('title', `lo${NUL}go`)
    expect(findNulPath(form)).toEqual(['title'])
  })

  it('leaves binary data alone', () => {
    const form = new FormData()
    form.append('file', new Blob([NUL, NUL]), 'raw.bin')
    expect(findNulPath(form)).toBeNull()
    expect(findNulPath({ bytes: new Uint8Array([0, 0, 0]) })).toBeNull()
  })

  it('leaves class instances alone', () => {
    class Opaque {
      text = `a${NUL}b`
    }
    expect(findNulPath({ value: new Opaque() })).toBeNull()
  })

  it('terminates on a cyclic input', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    node.children = [node, { name: 'leaf' }]
    expect(findNulPath(node)).toBeNull()

    node.children = [node, { name: `le${NUL}af` }]
    expect(findNulPath(node)).toEqual(['children', 1, 'name'])
  })

  it('walks a deeply nested input without recursion', () => {
    let deep: unknown = `x${NUL}`
    for (let depth = 0; depth < 50_000; depth++) deep = [deep]
    const path = findNulPath(deep)
    expect(path).toHaveLength(50_000)
    expect(path?.every((key) => key === 0)).toBe(true)
  })
})

describe('nulInputError', () => {
  it('has the shape of a validator error: a JSON list of issues', () => {
    const issues = JSON.parse(nulInputError(['data', 'search']).message)
    expect(issues).toEqual([
      { code: 'custom', path: ['data', 'search'], message: NUL_INPUT_MESSAGE },
    ])
  })
})

describe('serverFnNulGuard', () => {
  type ServerFn = (ctx: { data: unknown; next: () => unknown }) => unknown
  const server = (serverFnNulGuard.options as unknown as { server: ServerFn }).server

  it('passes a call without a NUL to the next middleware', () => {
    const next = vi.fn(() => 'result')
    expect(server({ data: { postId: 'post_01', search: 'dark mode' }, next })).toBe('result')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('refuses a call whose input holds a NUL before the function runs', () => {
    const next = vi.fn()
    expect(() => server({ data: { search: `dark${NUL}mode` }, next })).toThrow(NUL_INPUT_MESSAGE)
    expect(next).not.toHaveBeenCalled()
  })

  it('is registered for every server function, after the dispatch marker', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const start = readFileSync(join(here, '../../../../start.ts'), 'utf8')
    const list = start.match(/functionMiddleware:\s*\[([^\]]*)\]/)?.[1]
    const names =
      list
        ?.split(',')
        .map((name) => name.trim())
        .filter(Boolean) ?? []
    expect(names[0]).toBe('serverFnDispatchMarker')
    expect(names).toContain('serverFnNulGuard')
  })
})
