import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

/**
 * `overrides` in the root manifest exist to DEDUPE, not to pin a feature level.
 * `@tiptap/core|pm|suggestion` were pinned by 0c13abdb ("pin @tiptap
 * core/pm/suggestion to 3.23.4 to dedupe ProseMirror") because two copies of
 * ProseMirror break the editor at runtime.
 *
 * Dependabot never rewrites `overrides`. So when the grouped bump in #59 moved
 * the ~20 direct `@tiptap/*` dependencies to `^3.30.3`, the override held core
 * at 3.23.4 and `bun run build` died with four `[MISSING_EXPORT]` errors
 * against `node_modules/.bun/@tiptap+core@3.23.4` — `createWidgetDecoration`,
 * `attrsEqual`, `marksEqual`, `getPreviousBlockSibling`. Every future `@tiptap`
 * bump fails the same way, and the message names a symbol rather than the
 * override, so the cause is invisible from the failure.
 *
 * The invariant that actually catches this: an EXACT override must satisfy
 * every range the workspaces request for that package. On the #59 branch,
 * `3.23.4` does not satisfy `^3.30.3` — a contradiction visible in the
 * manifests alone, with no install and no network.
 *
 * NOTE a weaker check was tried first and was INERT here: "the override equals
 * the version the lockfile resolves". Bun honours the override when it writes
 * `bun.lock`, so on the broken branch the pin and the resolution agree at
 * 3.23.4 and the check passes while the build is broken. The contradiction is
 * between the override and the REQUESTED RANGE, never between the override and
 * its own resolution. `reports a violation for the #59 state` below pins that
 * lesson down so the guard cannot silently regress to the weaker form.
 */

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  overrides?: Record<string, string>
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

const EXACT_VERSION = /^\d+\.\d+\.\d+$/

function parseVersion(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function compare(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/**
 * Whether `version` satisfies `range`. Deliberately supports only the range
 * grammar this repository actually uses, and THROWS on anything else: a range
 * form nobody anticipated must fail the suite loudly rather than be skipped
 * into a false pass.
 */
export function satisfies(version: string, range: string): boolean {
  const trimmed = range.trim()
  if (trimmed === '*' || trimmed === 'latest' || trimmed === '') return true
  if (trimmed.includes('||')) {
    return trimmed.split('||').some((part) => satisfies(version, part))
  }
  if (EXACT_VERSION.test(trimmed)) return compare(version, trimmed) === 0
  if (/^\^\d+\.\d+\.\d+$/.test(trimmed)) {
    const floor = trimmed.slice(1)
    const [major] = parseVersion(floor)
    // Caret on a >=1.0.0 floor admits everything below the next major.
    // Below 1.0.0 npm narrows caret to the minor, which this repo does not use
    // for an overridden package; treat it as the stricter tilde to stay safe.
    if (major === 0) return satisfies(version, `~${floor}`)
    return compare(version, floor) >= 0 && parseVersion(version)[0] === major
  }
  if (/^~\d+\.\d+\.\d+$/.test(trimmed)) {
    const floor = trimmed.slice(1)
    const [major, minor] = parseVersion(floor)
    const actual = parseVersion(version)
    return compare(version, floor) >= 0 && actual[0] === major && actual[1] === minor
  }
  if (/^>=\d+\.\d+\.\d+$/.test(trimmed)) {
    return compare(version, trimmed.slice(2).trim()) >= 0
  }
  throw new Error(
    `Unsupported semver range "${range}" in a workspace manifest. Extend ` +
      `satisfies() in tests/dependency-override-lockstep.test.ts to cover it — ` +
      `do not skip it, or this guard goes inert for that dependency.`
  )
}

export interface RequestedRange {
  manifest: string
  section: string
  range: string
}

/** Every range each overridden package is requested at, across all workspaces. */
export function collectRequestedRanges(
  manifests: Array<{ path: string; manifest: Manifest }>,
  overridden: Set<string>
): Map<string, RequestedRange[]> {
  const requested = new Map<string, RequestedRange[]>()
  for (const { path, manifest } of manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (!overridden.has(name)) continue
        const list = requested.get(name) ?? []
        list.push({ manifest: path, section, range })
        requested.set(name, list)
      }
    }
  }
  return requested
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Manifest
}

function workspaceManifestPaths(): string[] {
  return [
    'package.json',
    ...globSync(['apps/*/package.json', 'packages/*/package.json', 'scripts/*/package.json'], {
      cwd: root,
    }).sort(),
  ]
}

describe('QB-DEP-001 root overrides stay in lockstep with requested ranges', () => {
  const rootManifest = readManifest('package.json')
  const overrides = rootManifest.overrides ?? {}
  const overridden = new Set(Object.keys(overrides))
  const manifests = workspaceManifestPaths().map((path) => ({
    path,
    manifest: readManifest(path),
  }))
  const requested = collectRequestedRanges(manifests, overridden)

  it('has overrides and workspace manifests to check', () => {
    // Without this, an empty override set or a broken glob would make every
    // generated assertion disappear and the suite would pass vacuously.
    expect(overridden.size).toBeGreaterThan(0)
    expect(manifests.length).toBeGreaterThan(1)
    expect(requested.size).toBeGreaterThan(0)
  })

  for (const [name, pinned] of Object.entries(overrides)) {
    if (!EXACT_VERSION.test(pinned)) continue
    const ranges = requested.get(name) ?? []
    if (ranges.length === 0) continue // transitive-only dedupe pin: no range to contradict

    it(`${name}@${pinned} satisfies every requested range`, () => {
      const violations = ranges.filter(({ range }) => !satisfies(pinned, range))
      expect(
        violations.map((v) => `${v.manifest} (${v.section}) wants ${v.range}`),
        `Root package.json "overrides"."${name}" pins ${pinned}, which does NOT ` +
          `satisfy the range(s) above. Dependabot does not update "overrides", ` +
          `so a grouped bump of the direct dependencies leaves this pin behind ` +
          `and the build fails later with an unrelated-looking [MISSING_EXPORT]. ` +
          `Raise "overrides"."${name}" to the version the direct dependencies ` +
          `now request, then re-run bun install.`
      ).toEqual([])
    })
  }

  it('reports a violation for the #59 state (guard-is-not-inert regression)', () => {
    // Exactly the shape of dependabot/bun/workspace-bun-c761106542: the direct
    // dependency moved to ^3.30.3 while the override stayed at 3.23.4.
    const fixture = [
      {
        path: 'apps/web/package.json',
        manifest: { dependencies: { '@tiptap/core': '^3.30.3' } },
      },
    ]
    const found = collectRequestedRanges(fixture, new Set(['@tiptap/core']))
    const ranges = found.get('@tiptap/core') ?? []
    expect(ranges).toHaveLength(1)
    expect(satisfies('3.23.4', ranges[0].range)).toBe(false)
    expect(satisfies('3.30.5', ranges[0].range)).toBe(true)
  })

  it('satisfies() throws on a range grammar it does not model', () => {
    expect(() => satisfies('1.2.3', '1.x')).toThrow(/Unsupported semver range/)
  })
})
