import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEV_SERVER_READY,
  DEV_SERVER_READY_LINE,
  isReadyStatus,
  probeOnce,
  resolveProbeTargets,
  startDevServer,
  waitForDevServer,
  type LookupAll,
} from '../../e2e/scripts/dev-server-ready'

/**
 * HYG-35: an end-to-end shard ran zero tests when the dev server left one
 * early readiness request unanswered and Playwright's untimed probe waited on
 * it for the whole 120 s webServer budget. e2e/scripts/dev-server-ready.ts
 * has the full cause.
 *
 * The stand-in below plays the dev server during that race. Each request gets
 * the next answer in `answers`, and the last one repeats. An answer is a
 * status code, or 'hold', which never answers: what the nitro dev worker did
 * with a request that arrived while its environment's entry was still
 * importing.
 */
type Answer = number | 'hold'

const servers: http.Server[] = []

async function standIn(answers: Answer[], host = '127.0.0.1') {
  let received = 0
  const hosts: (string | undefined)[] = []
  const server = http.createServer((request, response) => {
    const answer = answers[Math.min(received, answers.length - 1)]
    received += 1
    hosts.push(request.headers.host)
    if (answer === 'hold') return
    response.writeHead(answer).end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const { port } = server.address() as AddressInfo
  const origin = host.includes(':') ? `[${host}]` : host
  return { url: `http://${origin}:${port}/`, port, received: () => received, hosts }
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
})

/**
 * A lookup that answers per family, as the CI runner does for acme.localhost:
 * /etc/hosts gives 127.0.0.1, and the IPv6 lookup gives ::1.
 */
function lookupFrom(answers: { 4?: string[] | 'fail' | 'hang'; 6?: string[] | 'fail' | 'hang' }) {
  const calls: { hostname: string; family: 4 | 6 }[] = []
  const lookupAll: LookupAll = (hostname, options) => {
    calls.push({ hostname, family: options.family })
    const answer = answers[options.family] ?? []
    if (answer === 'fail') return Promise.reject(new Error(`ENOTFOUND ${hostname}`))
    if (answer === 'hang') return new Promise(() => {})
    return Promise.resolve(answer.map((address) => ({ address, family: options.family })))
  }
  return { lookupAll, calls }
}

describe('HYG-35 dev server readiness', () => {
  it('reproduces the wedge: an untimed probe, sent as Playwright sends it, is held by one unanswered request', async () => {
    const server = await standIn(['hold', 200])
    // playwright-core 1.63.0 httpStatusCode: one GET, no timeout, awaited
    // before the next probe is sent.
    const untimed = new Promise<number>((resolve) => {
      http
        .get(server.url, { agent: false, headers: { Accept: '*/*' } }, (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        .on('error', () => resolve(0))
    })
    const outcome = await Promise.race([
      untimed,
      new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 1000)),
    ])
    expect(outcome).toBe('still waiting')
    // The server would have answered the next request: it was never sent.
    expect(server.received()).toBe(1)
  })

  it('spends one bounded attempt on an unanswered request, waits through 503s, and reports the answer', async () => {
    const server = await standIn(['hold', 503, 503, 200])
    const lines: string[] = []
    const started = Date.now()
    const result = await waitForDevServer({
      url: server.url,
      attemptTimeoutMs: 300,
      intervalMs: 10,
      log: (line) => lines.push(line),
    })
    expect(result).toMatchObject({
      ready: true,
      attempts: 4,
      last: { status: 200, target: `127.0.0.1:${server.port}` },
    })
    expect(Date.now() - started).toBeLessThan(5000)
    // One line per change of answer.
    expect(lines).toEqual([
      `quackback e2e: dev server not ready yet (attempt 1: no response within 300 ms from 127.0.0.1:${server.port})`,
      `quackback e2e: dev server not ready yet (attempt 2: HTTP 503 from 127.0.0.1:${server.port})`,
    ])
  })

  it('never reports ready a server that does not answer, or answers 404, 500 or 503', async () => {
    for (const answers of [['hold'], [404], [500], [503]] as Answer[][]) {
      const server = await standIn(answers)
      const result = await waitForDevServer({
        url: server.url,
        attemptTimeoutMs: 100,
        intervalMs: 10,
        signal: AbortSignal.timeout(400),
      })
      expect(result.ready, JSON.stringify(answers)).toBe(false)
      expect(result.attempts, JSON.stringify(answers)).toBeGreaterThan(1)
    }
  })

  it('treats a port nothing listens on as not ready', async () => {
    const server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await closeServer(server)
    const result = await probeOnce(`http://127.0.0.1:${port}/`, 1000)
    expect(result.status).toBe(0)
    expect(result.error).toMatch(/ECONNREFUSED/)
  })

  it('logs a repeated answer again after stillWaitingLogMs, so a stuck wait is never silent', async () => {
    const server = await standIn([503])
    const lines: string[] = []
    await waitForDevServer({
      url: server.url,
      attemptTimeoutMs: 100,
      intervalMs: 10,
      stillWaitingLogMs: 100,
      signal: AbortSignal.timeout(450),
      log: (line) => lines.push(line),
    })
    expect(lines[0]).toBe(
      `quackback e2e: dev server not ready yet (attempt 1: HTTP 503 from 127.0.0.1:${server.port})`
    )
    const still = lines.slice(1)
    expect(still.length).toBeGreaterThanOrEqual(2)
    for (const line of still) {
      expect(line).toMatch(
        new RegExp(
          `^quackback e2e: dev server still not ready after \\d+ attempts, \\d+ ms \\(HTTP 503 from 127\\.0\\.0\\.1:${server.port}\\)$`
        )
      )
    }
  })

  it("uses Playwright's availability rule: 200 to 403", () => {
    for (const status of [200, 204, 302, 401, 403])
      expect(isReadyStatus(status), `${status}`).toBe(true)
    for (const status of [0, 199, 404, 500, 503])
      expect(isReadyStatus(status), `${status}`).toBe(false)
  })

  it('resolves the addresses Playwright would try: IPv6 and IPv4 interleaved, IPv6 first', async () => {
    const both = lookupFrom({ 6: ['::1'], 4: ['127.0.0.1', '127.0.0.2'] })
    await expect(resolveProbeTargets('acme.localhost', 1000, both.lookupAll)).resolves.toEqual([
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 },
      { address: '127.0.0.2', family: 4 },
    ])
    expect(both.calls).toEqual([
      { hostname: 'acme.localhost', family: 6 },
      { hostname: 'acme.localhost', family: 4 },
    ])
    // A family that fails, or hangs past the bound, contributes nothing.
    const noV6 = lookupFrom({ 6: 'fail', 4: ['127.0.0.1', '127.0.0.1'] })
    await expect(resolveProbeTargets('acme.localhost', 1000, noV6.lookupAll)).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ])
    const hung = lookupFrom({ 6: 'hang', 4: ['127.0.0.1'] })
    const started = Date.now()
    await expect(resolveProbeTargets('acme.localhost', 100, hung.lookupAll)).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ])
    expect(Date.now() - started).toBeLessThan(1000)
    // An IP literal is its own only address; no lookup runs.
    const none = lookupFrom({ 6: 'fail', 4: 'fail' })
    await expect(resolveProbeTargets('127.0.0.1', 1000, none.lookupAll)).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(resolveProbeTargets('[::1]', 1000, none.lookupAll)).resolves.toEqual([
      { address: '::1', family: 6 },
    ])
    expect(none.calls).toEqual([])
    await expect(resolveProbeTargets('acme.localhost', 1000, none.lookupAll)).resolves.toEqual([])
  })

  it('finds a server that listens only on IPv6 although the default lookup gives IPv4', async () => {
    // The CI shape: /etc/hosts maps acme.localhost to 127.0.0.1, nothing
    // listens there, and the dev server answers on ::1.
    const server = await standIn([200], '::1')
    const { lookupAll } = lookupFrom({ 6: ['::1'], 4: ['127.0.0.1'] })
    const lines: string[] = []
    const result = await waitForDevServer({
      url: `http://acme.localhost:${server.port}/`,
      attemptTimeoutMs: 1000,
      intervalMs: 10,
      lookupAll,
      signal: AbortSignal.timeout(3000),
      log: (line) => lines.push(line),
    })
    expect(result).toMatchObject({
      ready: true,
      attempts: 1,
      last: { status: 200, target: `[::1]:${server.port}` },
    })
    expect(lines).toEqual([])
    // Sent as Playwright sends it: with the URL's own Host header.
    expect(server.hosts).toEqual([`acme.localhost:${server.port}`])
  })

  it('reports every address when none is ready, and an unresolvable host as not ready', async () => {
    const server = await standIn([503], '::1')
    const { lookupAll } = lookupFrom({ 6: ['::1'], 4: ['127.0.0.1'] })
    const result = await probeOnce(`http://acme.localhost:${server.port}/`, 1000, { lookupAll })
    expect(result.status).toBe(503)
    expect(result.error).toMatch(
      new RegExp(
        `^HTTP 503 from \\[::1\\]:${server.port}; .*ECONNREFUSED.* from 127\\.0\\.0\\.1:${server.port}$`
      )
    )
    const unresolvable = await probeOnce('http://acme.localhost:3000/', 1000, {
      lookupAll: lookupFrom({ 6: 'fail', 4: 'fail' }).lookupAll,
    })
    expect(unresolvable).toEqual({ status: 0, error: 'could not resolve acme.localhost' })
  })

  it('prints the line playwright.config.ts waits for, and only when ready', async () => {
    const server = await standIn(['hold', 200])
    const lines: string[] = []
    const run = startDevServer({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      url: server.url,
      attemptTimeoutMs: 200,
      intervalMs: 10,
      log: (line) => lines.push(line),
    })
    try {
      await expect(run.ready).resolves.toMatchObject({ ready: true, attempts: 2 })
      expect(lines.filter((line) => DEV_SERVER_READY.test(line))).toEqual([
        expect.stringMatching(
          new RegExp(
            `^quackback e2e: dev server ready \\(HTTP 200 from 127\\.0\\.0\\.1:${server.port} after 2 attempts, \\d+ ms\\)$`
          )
        ),
      ])
      expect(DEV_SERVER_READY.test(lines.join('\n'))).toBe(true)
    } finally {
      run.child.kill('SIGTERM')
    }
    // Stopped by a signal: reported as a failure exit.
    await expect(run.exit).resolves.toBe(1)
    expect(DEV_SERVER_READY.test(DEV_SERVER_READY_LINE)).toBe(true)
    // It still matches after a partial line of the dev server's own output.
    expect(DEV_SERVER_READY.test(`vite partial output${DEV_SERVER_READY_LINE} (HTTP 200)`)).toBe(
      true
    )
    // The not-ready lines never match it.
    expect(lines.some((line) => line.includes('not ready') && DEV_SERVER_READY.test(line))).toBe(
      false
    )
  })

  it("forwards the dev server's exit code and stops waiting when it exits", async () => {
    const server = await standIn([503])
    const lines: string[] = []
    const run = startDevServer({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(3), 200)'],
      url: server.url,
      attemptTimeoutMs: 100,
      intervalMs: 10,
      log: (line) => lines.push(line),
    })
    await expect(run.exit).resolves.toBe(3)
    await expect(run.ready).resolves.toMatchObject({ ready: false, last: { status: 503 } })
    expect(lines.some((line) => DEV_SERVER_READY.test(line))).toBe(false)
  })

  it('is the webServer command playwright.config.ts starts, and waits for', () => {
    const config = readFileSync(path.resolve(__dirname, '../../playwright.config.ts'), 'utf8')
    expect(config).toContain("command: 'bun e2e/scripts/dev-server.ts'")
    expect(config).toContain('url: DEV_SERVER_URL')
    expect(config).toContain('wait: { stderr: DEV_SERVER_READY }')
    // The start budget is unchanged: a server that never answers still fails here.
    expect(config).toContain('timeout: 120 * 1000')
    const cli = readFileSync(path.resolve(__dirname, '../../e2e/scripts/dev-server.ts'), 'utf8')
    expect(cli).toContain("command: 'bun'")
    expect(cli).toContain("args: ['run', 'dev']")
    expect(cli).toContain('process.exit(await run.exit)')
  })
})
