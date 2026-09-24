/**
 * Runs the unmodified Venturi design suite v6.6.0 text-quality checker on every
 * route of the render plan, at every width the suite's policy lists, each as
 * rendered and with the WCAG 1.4.12 text-spacing stress (`--text-spacing`).
 *
 * Signed-in routes go through a session proxy (session-proxy.ts) so the
 * checker's own cookie-less browser context renders the signed-in page.
 * Signed-out routes go to the app directly.
 *
 * Writes one checker report per route to $RENDER_OUT_DIR/checker/<route>.json,
 * its console output beside it, and index.json listing every invocation. It
 * exits 0 whatever the checker found: summarize.ts reads the reports and
 * decides the job's result, so every report is written before anything fails.
 *
 * Usage (from apps/web, with the app serving the render plan's base URL):
 *   bun e2e/render/run-checker.ts
 * Environment:
 *   RENDER_OUT_DIR           where the plan is and the reports go
 *   RENDER_CHECKER_PARALLEL  checker processes at once (default 3)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CHECKER_DIR, SUITE_DIR, WEB_ROOT, readPlan, type Identity } from './plan'
import { startSessionProxy, type SessionProxy } from './session-proxy'

const CHECKER = path.join(SUITE_DIR, 'scripts/text-quality-check.mjs')
const POLICY = path.join(SUITE_DIR, 'SOURCE/quality-policy.json')
const PROXY_PORTS: Partial<Record<Identity, number>> = { admin: 3101, member: 3102 }
const PER_ROUTE_TIMEOUT_MS = 20 * 60 * 1000

/** Real directory of package `name` as resolved from directory `from`. */
function packageDir(name: string, from: string): string {
  const entry = fs.realpathSync(Bun.resolveSync(name, from))
  const marker = `${path.sep}node_modules${path.sep}${name}${path.sep}`
  const at = entry.lastIndexOf(marker)
  if (at === -1) throw new Error(`Cannot locate the ${name} package from ${from}`)
  return entry.slice(0, at + marker.length - 1)
}

/**
 * The node_modules directory the checker loads Playwright from: the one that
 * holds the `playwright` package @playwright/test itself uses, so the checker
 * drives the same Playwright, and the same installed Chromium, as the walk.
 */
function playwrightDependencies(): string {
  return path.dirname(packageDir('playwright', packageDir('@playwright/test', WEB_ROOT)))
}

async function sessionEmail(origin: string): Promise<string | null> {
  const response = await fetch(`${origin}/api/auth/get-session`)
  if (!response.ok) return null
  const body = (await response.json().catch(() => null)) as { user?: { email?: string } } | null
  return body?.user?.email ?? null
}

interface Invocation {
  route: string
  identity: Identity
  path: string
  url: string
  report: string
  log: string
  exitCode: number | null
  signal: string | null
  seconds: number
  reportWritten: boolean
}

function runOne(
  url: string,
  widths: number[],
  report: string,
  log: string,
  env: NodeJS.ProcessEnv
) {
  const args = [CHECKER, '--url', url]
  for (const width of widths) args.push('--width', String(width))
  args.push('--text-spacing', '--output', report)
  return new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    const out = fs.openSync(log, 'w')
    const child = spawn('node', args, { env, stdio: ['ignore', out, out] })
    const timer = setTimeout(() => child.kill('SIGKILL'), PER_ROUTE_TIMEOUT_MS)
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      fs.closeSync(out)
      resolve({ exitCode, signal })
    })
  })
}

async function main(): Promise<void> {
  const plan = readPlan()
  const policy = JSON.parse(fs.readFileSync(POLICY, 'utf8')) as {
    viewports: { responsiveWidthsCssPx: number[] }
  }
  const widths = policy.viewports.responsiveWidthsCssPx
  if (!Array.isArray(widths) || widths.length === 0) {
    throw new Error('The pinned policy lists no responsive widths')
  }
  fs.mkdirSync(CHECKER_DIR, { recursive: true })

  const env = { ...process.env, DESIGN_TEST_DEPENDENCIES: playwrightDependencies() }
  const parallel = Math.max(1, Number(process.env.RENDER_CHECKER_PARALLEL || 3))
  const proxies: SessionProxy[] = []
  const origins: Partial<Record<Identity, string>> = { anonymous: plan.baseURL }
  try {
    for (const identity of ['admin', 'member'] as const) {
      const storageStatePath = plan.storageStates[identity]
      const port = PROXY_PORTS[identity]
      if (!storageStatePath || !port) throw new Error(`No session source for ${identity}`)
      const proxy = startSessionProxy({
        port,
        upstream: plan.baseURL,
        storageStatePath,
        alsoRewrite: process.env.BASE_URL ? [new URL(process.env.BASE_URL).origin] : [],
      })
      proxies.push(proxy)
      // Prove the proxy serves the identity before measuring anything with it.
      const email = await sessionEmail(proxy.origin)
      if (email !== plan.emails[identity]) {
        throw new Error(
          `The ${identity} proxy's session belongs to ${email ?? 'nobody'}, expected ${plan.emails[identity]}`
        )
      }
      origins[identity] = proxy.origin
      console.log(`${identity}: signed in as ${email} through ${proxy.origin}`)
    }

    console.log(
      `Widths from the pinned policy: ${widths.join(', ')} (each as rendered and with text spacing)`
    )
    const queue = [...plan.routes]
    const invocations: Invocation[] = []
    const worker = async () => {
      for (let route = queue.shift(); route; route = queue.shift()) {
        const url = `${origins[route.identity]}${route.path}`
        const report = path.join(CHECKER_DIR, `${route.id}.json`)
        const log = path.join(CHECKER_DIR, `${route.id}.log`)
        const started = Date.now()
        const { exitCode, signal } = await runOne(url, widths, report, log, env)
        const seconds = Math.round((Date.now() - started) / 1000)
        const reportWritten = fs.existsSync(report)
        invocations.push({
          route: route.id,
          identity: route.identity,
          path: route.path,
          url,
          report: path.basename(report),
          log: path.basename(log),
          exitCode,
          signal,
          seconds,
          reportWritten,
        })
        console.log(`${route.id}: exit ${exitCode ?? signal} after ${seconds}s`)
      }
    }
    await Promise.all(Array.from({ length: parallel }, worker))
    invocations.sort((a, b) => a.route.localeCompare(b.route))
    fs.writeFileSync(
      path.join(CHECKER_DIR, 'index.json'),
      `${JSON.stringify({ widths, textSpacing: true, parallel, invocations }, null, 2)}\n`
    )
  } finally {
    for (const proxy of proxies) proxy.stop()
  }
}

await main()
