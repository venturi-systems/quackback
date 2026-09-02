import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The e2e lane is sharded (`--shard=N/4` in ci.yml) and each shard is its own
 * job with its own database. Playwright splits the TEST LIST across shards; a
 * project's `setup` only runs in a shard because some project in that shard
 * declares it as a dependency. So a project without `dependencies: ['setup']`
 * runs with no authenticated state and no e2e auth configuration whenever a
 * shard happens to contain only that project — which is not hypothetical:
 * shard 4 of 4 is 195 chromium-public tests and nothing else.
 *
 * Two things break silently when setup is skipped, and both are shard-
 * dependent, so the lane goes red on some shards and green on others for the
 * same tree:
 *   - `e2e/.auth/admin.json` is never written (unified-login.spec.ts reads it).
 *   - The magic-link sign-in method is never enabled. `db:seed` leaves
 *     `settings.auth_config` NULL and `isSignInMethodEnabled` treats magicLink
 *     as opt-in, so both `loginViaMagicLink` and the email-OTP sign-in used by
 *     voting/comments specs are refused with `magic_link_method_not_allowed`.
 *
 * This test pins the invariant at the config level rather than waiting for a
 * shard to expose it. playwright.config.ts sits outside apps/web/tsconfig's
 * `include` (src only), so it is loaded through a dynamic import with a
 * runtime-computed specifier: vitest transforms the file, TypeScript never has
 * to resolve it.
 */

interface PlaywrightProject {
  name?: string
  dependencies?: string[]
  testMatch?: RegExp | string
}

const WEB_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** Projects that ARE the setup/teardown machinery, not consumers of it. */
const INFRASTRUCTURE_PROJECTS = new Set(['setup', 'cleanup'])

async function loadProjects(): Promise<PlaywrightProject[]> {
  const configPath = join(WEB_ROOT, 'playwright.config.ts')
  const mod = await import(/* @vite-ignore */ configPath)
  const projects = (mod.default as { projects?: PlaywrightProject[] }).projects
  return projects ?? []
}

/** Every `*.spec.ts` under e2e/tests, as a path relative to apps/web/e2e. */
function listSpecFiles(): string[] {
  const root = join(WEB_ROOT, 'e2e', 'tests')
  const out: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`)
      else if (entry.endsWith('.spec.ts')) out.push(`${prefix}${entry}`)
    }
  }
  walk(root, 'tests/')
  return out
}

function matches(testMatch: RegExp | string | undefined, file: string): boolean {
  if (testMatch instanceof RegExp) return testMatch.test(file)
  if (typeof testMatch === 'string') return file.includes(testMatch)
  return false
}

describe('playwright project dependencies', () => {
  it('declares setup as a dependency of every spec-running project', async () => {
    const projects = await loadProjects()
    const specRunning = projects.filter((p) => p.name && !INFRASTRUCTURE_PROJECTS.has(p.name))
    // Guard the guard: if the config is ever restructured so no project is
    // classified as spec-running, the loop below would assert nothing.
    expect(specRunning.length).toBeGreaterThan(0)

    for (const project of specRunning) {
      expect(
        project.dependencies ?? [],
        `project "${project.name}" must depend on setup`
      ).toContain('setup')
    }
  })

  it('routes every e2e spec file to a project, so the dependency above covers all of them', async () => {
    const projects = await loadProjects()
    const specRunning = projects.filter((p) => p.name && !INFRASTRUCTURE_PROJECTS.has(p.name))
    const files = listSpecFiles()
    expect(files.length).toBeGreaterThan(0)

    const unrouted = files.filter((f) => !specRunning.some((p) => matches(p.testMatch, f)))
    expect(unrouted, 'spec files matched by no project would never run at all').toEqual([])
  })

  it('keeps a setup project whose testMatch actually selects global-setup.ts', async () => {
    const projects = await loadProjects()
    const setup = projects.find((p) => p.name === 'setup')
    expect(
      setup,
      'a project named "setup" must exist for the dependencies to resolve'
    ).toBeDefined()
    expect(matches(setup?.testMatch, 'global-setup.ts')).toBe(true)
  })
})
