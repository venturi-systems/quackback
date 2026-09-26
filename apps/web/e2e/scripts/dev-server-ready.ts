/**
 * When the end-to-end dev server is ready (HYG-35).
 *
 * WHAT FAILED. A shard now and then ran zero tests: runs 35979125225 (shard
 * 6), 35987468148 (shard 2) and 36221778895 (shard 3), each green on re-run.
 * All three logs have the same shape. `vite dev` starts; about five seconds
 * later the dev server prints one
 * `NitroViteError: Vite environment "nitro" is unavailable` (status 503);
 * then nothing, until Playwright gives up with
 * `Timed out waiting 120000ms from config.webServer`. On shard 3 of run
 * 36221778895: `vite dev` at 05:47:38.52Z, the 503 at 05:47:43.60Z, the
 * timeout at 05:49:38.58Z.
 *
 * WHY. Read from the sources bun.lock pins (sha512 checked against it):
 *
 *   1. nitro 3.0.260415-beta (runtime/internal/vite/dev-worker.mjs). The dev
 *      worker registers the `nitro` Vite environment and starts importing the
 *      app entry. A request that arrives before that import finishes waits
 *      3.1 s (ViteEnvRunner.fetch), then THROWS the 503 instead of returning
 *      it as a response.
 *   2. env-runner 0.1.7 serves the worker with srvx 0.11.15 and no error
 *      handler, and srvx's node adapter does not catch a rejected fetch. The
 *      error only reaches the worker's unhandledRejection trap, which prints
 *      it: the one line in the log. That request is never answered. The host
 *      forwards requests to the worker with httpxy 0.5.0 `proxyFetch` and no
 *      timeout, so the client's request is never answered either.
 *   3. Playwright 1.63.0 probes `webServer.url` with no per-request timeout
 *      (playwright-core httpStatusCode) and awaits each probe before sending
 *      the next. The one unanswered probe holds readiness for the whole 120 s
 *      budget, although the server is serving seconds later.
 *
 * It is a timing race: the first probe has to land after the environment is
 * registered and more than 3.1 s before its entry import finishes, which a
 * slow cold start on a shared runner sometimes allows. On the green re-run of
 * that shard (run 36221778895 attempt 2), Playwright started the tests
 * 14.8 s after `vite dev` started.
 *
 * WHAT THIS DOES. It asks Playwright's own question -- does the tenant URL
 * answer with a status from 200 to 403 -- but bounds every attempt, so a
 * request the server never answers costs one attempt instead of the start
 * budget. A 503 from an environment that is still loading counts as "not
 * ready yet", as Playwright counts it. It retries no test and widens no
 * timeout: a server that never answers still fails at Playwright's 120 s
 * webServer timeout, and a dev server that exits fails the start at once
 * with its exit code (e2e/scripts/dev-server.ts).
 *
 * Upstream nitro fixed the dev worker in 3.0.260903-beta: it waits for the
 * in-flight import and renders errors instead of throwing them. This check
 * stays correct after that upgrade, because it only ever waits for an answer.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'

/** The URL the suite drives (playwright.config.ts `use.baseURL`). */
export const DEV_SERVER_URL = 'http://acme.localhost:3000'

/**
 * Printed on stderr once the dev server answers; playwright.config.ts waits
 * for it. Not anchored to a line start: the dev server writes to the same
 * stderr, and a partial line of its output can precede this one. The
 * not-ready line never contains it.
 */
export const DEV_SERVER_READY_LINE = 'quackback e2e: dev server ready'
export const DEV_SERVER_READY = /quackback e2e: dev server ready\b/

/**
 * How long one attempt may wait for a status line. Longer than the whole cold
 * start measured on a green shard (14.8 s from `vite dev` starting to the
 * tests starting, run 36221778895 attempt 2, shard 3), so an honest first
 * answer is not cut short; if one ever is, the next attempt finds the compile
 * warm. An unanswered request costs one attempt, well inside the 120 s budget.
 */
export const ATTEMPT_TIMEOUT_MS = 20_000

/** Pause between attempts. */
export const ATTEMPT_INTERVAL_MS = 250

/** Playwright's rule (playwright-core isURLAvailable): 200 to 403 is available. */
export function isReadyStatus(status: number): boolean {
  return status >= 200 && status < 404
}

export interface ProbeResult {
  /** HTTP status, or 0 when no status line arrived. */
  status: number
  error?: string
}

/**
 * One GET of `url`, as Playwright sends it (`Accept: *\/*`, body discarded),
 * that settles within `timeoutMs` whether or not the server answers.
 */
export function probeOnce(url: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    // agent: false -- a fresh connection per attempt, closed after it, so a
    // held connection is never reused and no pooled socket outlives the check.
    const request = http.get(url, { agent: false, headers: { Accept: '*/*' } }, (response) => {
      response.resume()
      settle({ status: response.statusCode ?? 0 })
    })
    request.on('error', (error) => settle({ status: 0, error: error.message }))
    const timer = setTimeout(() => {
      settle({ status: 0, error: `no response within ${timeoutMs} ms` })
      request.destroy()
    }, timeoutMs)
  })
}

function describeProbe(result: ProbeResult): string {
  return result.error ?? `HTTP ${result.status}`
}

export interface WaitOptions {
  url: string
  attemptTimeoutMs?: number
  intervalMs?: number
  /** Stops the wait, for example when the dev server exits. */
  signal?: AbortSignal
  log?: (line: string) => void
}

export interface WaitResult {
  ready: boolean
  attempts: number
  elapsedMs: number
  last?: ProbeResult
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Probe until the server answers with a ready status or `signal` aborts.
 * There is no deadline of its own: Playwright's webServer timeout is the
 * deadline, and it still fails a server that never answers.
 */
export async function waitForDevServer(options: WaitOptions): Promise<WaitResult> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? ATTEMPT_INTERVAL_MS
  const started = Date.now()
  let attempts = 0
  let last: ProbeResult | undefined
  let reported = ''
  while (!options.signal?.aborted) {
    attempts += 1
    last = await probeOnce(options.url, attemptTimeoutMs)
    if (isReadyStatus(last.status)) {
      return { ready: true, attempts, elapsedMs: Date.now() - started, last }
    }
    // One line per change of answer, not one per attempt: the first seconds
    // are all "connection refused" while Vite starts.
    const summary = describeProbe(last)
    if (summary !== reported) {
      options.log?.(`quackback e2e: dev server not ready yet (attempt ${attempts}: ${summary})`)
      reported = summary
    }
    await pause(intervalMs, options.signal)
  }
  return { ready: false, attempts, elapsedMs: Date.now() - started, last }
}

export interface DevServerOptions {
  command: string
  args: string[]
  url: string
  attemptTimeoutMs?: number
  intervalMs?: number
  log?: (line: string) => void
}

export interface DevServerRun {
  child: ChildProcess
  /** Settles when the server is ready, or with ready: false once it exits. */
  ready: Promise<WaitResult>
  /** The dev server's exit code; 1 when a signal or a spawn error ended it. */
  exit: Promise<number>
}

/**
 * Start the dev server, report it ready once it answers, and forward its exit
 * code. Its output goes straight to this process's stdout and stderr, as it
 * did when Playwright started it directly.
 */
export function startDevServer(options: DevServerOptions): DevServerRun {
  const log = options.log ?? (() => {})
  const child = spawn(options.command, options.args, { stdio: 'inherit' })
  const stopped = new AbortController()
  const exit = new Promise<number>((resolve) => {
    child.once('error', (error) => {
      log(`quackback e2e: could not start the dev server: ${error.message}`)
      stopped.abort()
      resolve(1)
    })
    child.once('exit', (code, signal) => {
      if (code === null)
        log(`quackback e2e: dev server stopped by ${signal ?? 'an unknown signal'}`)
      stopped.abort()
      resolve(code ?? 1)
    })
  })
  const ready = waitForDevServer({
    url: options.url,
    attemptTimeoutMs: options.attemptTimeoutMs,
    intervalMs: options.intervalMs,
    signal: stopped.signal,
    log,
  }).then((result) => {
    if (result.ready && result.last) {
      log(
        `${DEV_SERVER_READY_LINE} (${describeProbe(result.last)} after ${result.attempts} attempts, ${result.elapsedMs} ms)`
      )
    }
    return result
  })
  return { child, ready, exit }
}
