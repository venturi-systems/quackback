#!/usr/bin/env bun
/** Job-owned compiled server. Local development continues through dev-server.ts. */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_SERVER_URL, waitForDevServer } from './dev-server-ready'
import {
  assertDesignFixtureEnvironmentSync,
  designFixtureEnvironmentReceipt,
  fixtureAppEnvironment,
  fixtureAppLabels,
  LOCAL_DOCKER_ENDPOINT,
  validateDesignFixtureEnvironment,
  validateFixtureAppContainer,
  validateFixtureAppImage,
  type FixtureAppContainer,
  type FixtureAppImage,
} from '../utils/design-fixture-guard'

interface Checkout {
  schema: number
  run_id: number
  run_attempt: number
  shard: number
  commit: string
  tree: string
}
interface AppReceipt extends Checkout {
  mode: 'development'
  image_id: string
  container_id: string
  fixture_receipt: string
}

export interface ImageServerIO {
  env: NodeJS.ProcessEnv
  cidfile: string
  preflight: () => void
  command: (command: string, args: string[]) => string
  read: (name: string) => string | undefined
  write: (name: string, value: unknown) => void
  writeLog: (value: string) => void
  exportEnvironment: (env: Record<string, string>) => void
  assertPortFree: () => Promise<void>
  wait: () => Promise<void>
  verifyDevelopmentMode: () => Promise<DevelopmentModeProbe>
}

const ERROR = 'E2E compiled fixture validation failed'
const jsonObject = <T>(value: string | undefined): T => {
  if (!value) throw new Error(ERROR)
  return JSON.parse(value) as T
}
const only = <T>(value: string): T => {
  const values = jsonObject<T[]>(value)
  if (!Array.isArray(values) || values.length !== 1) throw new Error(ERROR)
  return values[0]
}
const docker = (io: ImageServerIO, args: string[]) =>
  io.command('docker', ['--host', LOCAL_DOCKER_ENDPOINT, ...args])

function savedCheckout(io: ImageServerIO): Checkout {
  validateDesignFixtureEnvironment(io.env)
  const saved = jsonObject<Checkout>(io.read('tested-tree.json'))
  if (
    saved.schema !== 1 ||
    saved.run_id !== Number(io.env.GITHUB_RUN_ID) ||
    saved.run_attempt !== Number(io.env.GITHUB_RUN_ATTEMPT) ||
    !/^[1-8]$/.test(io.env.E2E_IMAGE_SHARD ?? '') ||
    saved.shard !== Number(io.env.E2E_IMAGE_SHARD) ||
    !/^[a-f0-9]{40}$/.test(saved.commit) ||
    !/^[a-f0-9]{40}$/.test(saved.tree)
  )
    throw new Error(ERROR)
  return {
    schema: 1,
    run_id: saved.run_id,
    run_attempt: saved.run_attempt,
    shard: saved.shard,
    commit: saved.commit,
    tree: saved.tree,
  }
}

function assertCheckoutUnchanged(io: ImageServerIO, saved: Checkout): void {
  if (
    saved.commit !== io.command('git', ['rev-parse', 'HEAD']).trim() ||
    saved.tree !== io.command('git', ['rev-parse', 'HEAD^{tree}']).trim()
  )
    throw new Error(ERROR)
  io.command('git', ['diff', '--exit-code', 'HEAD', '--'])
}

function serviceReceipt(env: NodeJS.ProcessEnv): string {
  const services = { ...env }
  for (const name of [
    'E2E_SERVER_MODE',
    'DESIGN_FIXTURE_APP_ID',
    'DESIGN_FIXTURE_APP_IMAGE',
    'DESIGN_FIXTURE_APP_REVISION',
    'DESIGN_FIXTURE_APP_MODE',
    'DESIGN_FIXTURE_SHARD',
  ])
    delete services[name]
  return designFixtureEnvironmentReceipt(services)
}

interface AttemptReceipt extends Checkout {
  image_id: string
  phase: 'pre-create'
  service_receipt: string
}

function readAttempt(io: ImageServerIO, saved: Checkout): AttemptReceipt {
  const attempt = jsonObject<AttemptReceipt>(io.read('image-server-attempt.json'))
  if (
    attempt.phase !== 'pre-create' ||
    Object.entries(saved).some(([key, value]) => attempt[key as keyof Checkout] !== value) ||
    !/^sha256:[a-f0-9]{64}$/.test(attempt.image_id) ||
    attempt.service_receipt !== serviceReceipt(io.env)
  )
    throw new Error(ERROR)
  return attempt
}

interface ProcessIdentity {
  pid: number
  started_at: string
  restart_count: number
}
function processIdentity(container: FixtureAppContainer): ProcessIdentity {
  const pid = container.State.Pid
  const started = container.State.StartedAt
  const restarts = container.RestartCount
  if (
    !Number.isSafeInteger(pid) ||
    pid! <= 0 ||
    typeof started !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(started) ||
    !Number.isFinite(Date.parse(started)) ||
    Date.parse(started) <= 0 ||
    !Number.isSafeInteger(restarts) ||
    restarts! < 0
  )
    throw new Error(ERROR)
  const milliseconds = started.replace(/(\.\d{3})\d+(Z)$/, '$1$2')
  if (
    new Date(started).toISOString() !==
    milliseconds.replace(
      /(?:\.(\d{1,3}))?Z$/,
      (_match, fraction: string | undefined) => '.' + (fraction ?? '').padEnd(3, '0') + 'Z'
    )
  )
    throw new Error(ERROR)
  return { pid: pid!, started_at: started, restart_count: restarts! }
}

function appTuple(receipt: AppReceipt): Record<string, string> {
  return {
    E2E_SERVER_MODE: 'image',
    DESIGN_FIXTURE_APP_ID: receipt.container_id,
    DESIGN_FIXTURE_APP_IMAGE: receipt.image_id,
    DESIGN_FIXTURE_APP_REVISION: receipt.commit,
    DESIGN_FIXTURE_APP_MODE: receipt.mode,
    DESIGN_FIXTURE_SHARD: String(receipt.shard),
  }
}

function validateReceipt(
  io: ImageServerIO,
  saved: Checkout,
  receipt: AppReceipt
): NodeJS.ProcessEnv {
  if (
    receipt.schema !== 1 ||
    receipt.mode !== 'development' ||
    receipt.run_id !== saved.run_id ||
    receipt.run_attempt !== saved.run_attempt ||
    receipt.shard !== saved.shard ||
    receipt.commit !== saved.commit ||
    receipt.tree !== saved.tree ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.image_id) ||
    !/^[a-f0-9]{64}$/.test(receipt.container_id)
  )
    throw new Error(ERROR)
  const tuple = appTuple(receipt)
  // Exported identity must agree with the receipt; never overwrite drift during cleanup.
  if (
    Object.entries(tuple).some(
      ([name, value]) => io.env[name] !== undefined && io.env[name] !== value
    )
  )
    throw new Error(ERROR)
  const env = { ...io.env, ...tuple }
  if (designFixtureEnvironmentReceipt(env) !== receipt.fixture_receipt) throw new Error(ERROR)
  return env
}

function inspected(
  io: ImageServerIO,
  env: NodeJS.ProcessEnv,
  phase: 'created' | 'running' | 'retained'
) {
  const image = only<FixtureAppImage>(
    docker(io, ['image', 'inspect', env.DESIGN_FIXTURE_APP_IMAGE!])
  )
  const container = only<FixtureAppContainer>(docker(io, ['inspect', env.DESIGN_FIXTURE_APP_ID!]))
  validateFixtureAppContainer(env, image, container, env.DESIGN_FIXTURE_APP_REVISION!, phase)
  return container
}

export async function startImageServer(imageId: string, io: ImageServerIO): Promise<AppReceipt> {
  // No app/container/fixture operation is allowed before the existing service guard.
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error(ERROR)
  io.preflight()
  if (io.env.E2E_SERVER_MODE !== undefined) throw new Error(ERROR)
  const saved = savedCheckout(io)
  assertCheckoutUnchanged(io, saved)
  if (
    io.read('image-server-owned.json') !== undefined ||
    io.read('image-server-attempt.json') !== undefined ||
    io.read('image-server.cid') !== undefined ||
    !isAbsolute(io.cidfile)
  )
    throw new Error(ERROR)
  const image = only<FixtureAppImage>(docker(io, ['image', 'inspect', imageId]))
  validateFixtureAppImage(image, imageId, saved.commit)
  const appEnv = fixtureAppEnvironment(io.env)
  const labels = fixtureAppLabels({ ...io.env, DESIGN_FIXTURE_SHARD: String(saved.shard) })
  await io.assertPortFree()
  // Retain the exact service/source binding before Docker can create anything.
  io.write('image-server-attempt.json', {
    ...saved,
    image_id: imageId,
    phase: 'pre-create',
    service_receipt: serviceReceipt(io.env),
  })
  const output = docker(io, [
    'create',
    '--pull=never',
    '--network',
    'host',
    '--cidfile',
    io.cidfile,
    '--name',
    `quackback-e2e-${saved.run_id}-${saved.run_attempt}-${saved.shard}`,
    ...Object.entries(labels).flatMap(([name, value]) => ['--label', `${name}=${value}`]),
    ...Object.entries(appEnv).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    imageId,
  ]).trim()
  const containerId = io.read('image-server.cid')?.trim()
  if (!containerId || !/^[a-f0-9]{64}$/.test(containerId) || output !== containerId)
    throw new Error(ERROR)
  const receipt: AppReceipt = {
    ...saved,
    mode: 'development',
    image_id: imageId,
    container_id: containerId,
    fixture_receipt: '',
  }
  const env = { ...io.env, ...appTuple(receipt) }
  receipt.fixture_receipt = designFixtureEnvironmentReceipt(env)
  io.write('image-server-owned.json', receipt)
  inspected(io, env, 'created')
  io.write('image-server-before.json', { ...receipt, inspected_before_start: true })
  docker(io, ['start', containerId])
  inspected(io, env, 'running')
  await io.wait()
  const before = processIdentity(inspected(io, env, 'running'))
  const probe = await io.verifyDevelopmentMode()
  const after = processIdentity(inspected(io, env, 'running'))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(ERROR)
  io.write('image-server-ready.json', {
    ...receipt,
    inspected_before_start: true,
    ready: true,
    // This records the bounded limiter/origin controls, not full mode parity.
    runtime_development_mode_verified: true,
    development_mode_probe: probe,
    process_identity: after,
    process_continuity_verified: true,
  })
  io.exportEnvironment(appTuple(receipt))
  return receipt
}

/** This step is always-run by CI; only the captured, positively verified ID may be stopped. */
export function finishImageServer(io: ImageServerIO): void {
  validateDesignFixtureEnvironment(io.env)
  const raw = io.read('image-server-owned.json')
  const cid = io.read('image-server.cid')?.trim()
  const attempted = io.read('image-server-attempt.json') !== undefined
  if (raw === undefined && !cid) {
    // No recorded ID cannot prove Docker did not create an app.
    io.write('image-server-after.json', {
      schema: 1,
      attempted,
      created: null,
      creation_confirmed: false,
      stopped: false,
      problems: attempted ? ['creation-unconfirmed'] : [],
    })
    if (attempted) throw new Error(ERROR + ': creation-unconfirmed')
    return
  }
  const saved = savedCheckout(io)
  const attempt = readAttempt(io, saved)
  if (!cid || !/^[a-f0-9]{64}$/.test(cid)) throw new Error(ERROR)
  const recovered: AppReceipt = {
    ...saved,
    mode: 'development',
    image_id: attempt.image_id,
    container_id: cid,
    fixture_receipt: '',
  }
  recovered.fixture_receipt = designFixtureEnvironmentReceipt({ ...io.env, ...appTuple(recovered) })
  const stored = raw === undefined ? recovered : jsonObject<AppReceipt>(raw)
  if (stored.container_id !== cid || stored.image_id !== attempt.image_id) throw new Error(ERROR)
  const env = validateReceipt(io, saved, stored)
  const receipt: AppReceipt = {
    ...saved,
    mode: 'development',
    image_id: stored.image_id,
    container_id: stored.container_id,
    fixture_receipt: stored.fixture_receipt,
  }
  // Retained source/service/ID/configuration proof permits owned cleanup even
  // when live Git drift or failure makes successful source reuse impossible.
  const container = inspected(io, env, 'retained')
  const problems: string[] = []
  let sourceUnchanged = false
  try {
    assertCheckoutUnchanged(io, saved)
    sourceUnchanged = true
  } catch {
    problems.push('source-changed-or-unavailable')
  }
  const after = {
    ...receipt,
    created: true,
    creation_confirmed: true,
    recovered_from_cid: raw === undefined,
    source_unchanged: sourceUnchanged,
    configuration_verified: true,
    running_before_stop: container.State.Running,
    stopped: false,
  }
  try {
    try {
      io.writeLog(docker(io, ['logs', receipt.container_id]))
    } catch {
      problems.push('log-capture-failed')
    }
    if (!container.State.Running) problems.push('app-exited-before-cleanup')
  } finally {
    try {
      if (container.State.Running) docker(io, ['stop', '--time', '10', receipt.container_id])
      const stopped = inspected(io, env, 'retained')
      after.stopped = !stopped.State.Running
      if (!after.stopped) problems.push('owned-container-still-running')
    } catch {
      problems.push('owned-container-stop-failed')
    }
    io.write('image-server-after.json', { ...after, problems })
  }
  if (problems.length) throw new Error(`${ERROR}: ${problems.join(', ')}`)
}

function runtimeIO(): ImageServerIO {
  const env = process.env
  if (!isAbsolute(env.RUNNER_TEMP ?? '') || !isAbsolute(env.GITHUB_ENV ?? ''))
    throw new Error(ERROR)
  const directory = resolve(env.RUNNER_TEMP!, 'e2e-evidence')
  const safePath = (name: string) => {
    if (!/^(?:tested-tree\.json|image-server-[a-z.-]+)$/.test(name)) throw new Error(ERROR)
    return resolve(directory, name)
  }
  const command = (name: string, args: string[]): string => {
    try {
      if (name === 'docker' && args[2] === 'logs') {
        const result = spawnSync(name, args, {
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        if (result.error || result.status !== 0) throw result.error ?? { status: result.status }
        return result.stdout + result.stderr
      }
      return execFileSync(name, args, {
        cwd: resolve(fileURLToPath(new URL('../../../..', import.meta.url))),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    } catch (error) {
      const failure = error as { code?: string; status?: number }
      const code = ['ENOENT', 'EACCES', 'ETIMEDOUT'].includes(failure.code ?? '')
        ? failure.code
        : 'CHILD_FAILED'
      throw new Error(`${ERROR}: ${name}`, {
        cause: new Error(
          `${code}; status=${typeof failure.status === 'number' ? failure.status : 'unknown'}`
        ),
      })
    }
  }
  return {
    env,
    cidfile: safePath('image-server.cid'),
    preflight: assertDesignFixtureEnvironmentSync,
    command,
    read: (name) => (existsSync(safePath(name)) ? readFileSync(safePath(name), 'utf8') : undefined),
    write: (name, value) =>
      writeFileSync(safePath(name), JSON.stringify(value) + '\n', { flag: 'wx' }),
    writeLog: (value) => writeFileSync(safePath('image-server.log'), value, { flag: 'wx' }),
    exportEnvironment: (values) =>
      appendFileSync(
        env.GITHUB_ENV!,
        Object.entries(values)
          .map(([name, value]) => `${name}=${value}\n`)
          .join('')
      ),
    assertPortFree: () =>
      new Promise((yes, no) => {
        const server = createServer()
        server.once('error', () => no(new Error(`${ERROR}: app-port-unavailable`)))
        server.listen(3000, '127.0.0.1', () =>
          server.close((error) => (error ? no(new Error(ERROR)) : yes()))
        )
      }),
    wait: async () => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          waitForDevServer({ url: DEV_SERVER_URL, signal: controller.signal }),
          new Promise<never>((_yes, no) => {
            timer = setTimeout(() => no(new Error(`${ERROR}: readiness-timeout`)), 120_000)
          }),
        ])
        if (!result.ready) throw new Error(`${ERROR}: app-not-ready`)
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    },
    verifyDevelopmentMode: verifyCompiledDevelopmentMode,
  }
}

export interface DevelopmentModeProbe {
  /** Four same-IP/path limiter controls, followed by one rejected-origin control. */
  requests: 4
  elapsed_ms: number
  origin_rejected: true
}

interface ProbeFailureReceipt {
  request_index: number
  status: number | null
  code: 'VALIDATION_ERROR' | 'INVALID_CALLBACK_URL' | 'OTHER' | null
  elapsed_ms: number | null
  reason: 'window' | 'request' | 'response' | 'validation' | 'origin'
}

export class ImageServerProbeError extends Error {
  constructor(readonly receipt: ProbeFailureReceipt) {
    super(ERROR + ': development-mode-not-established')
  }
}

/** Check the compiled server's development limiter and callback-origin behavior.
 * Four identical missing-email requests must reach schema validation inside the
 * production limiter's 60-second window. A fifth request supplies an untrusted
 * callback URL as data and must be rejected before schema validation. No request
 * supplies an email, follows a redirect, or contacts that callback URL.
 */
export async function verifyCompiledDevelopmentMode(
  request: typeof fetch = fetch,
  now: () => number = () => performance.now()
): Promise<DevelopmentModeProbe> {
  const started = now()
  let requestIndex = 0
  let status: number | null = null
  let code: ProbeFailureReceipt['code'] = null
  const fail = (reason: ProbeFailureReceipt['reason']): never => {
    const value = now() - started
    throw new ImageServerProbeError({
      request_index: requestIndex,
      status,
      code,
      elapsed_ms: Number.isFinite(value) && value >= 0 ? value : null,
      reason,
    })
  }
  const elapsed = () => {
    const value = now() - started
    if (!Number.isFinite(value) || value < 0 || value >= 60_000) fail('window')
    return value
  }
  for (requestIndex = 1; requestIndex <= 5; requestIndex++) {
    status = null
    code = null
    elapsed()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_yes, no) => {
      timer = setTimeout(() => {
        controller.abort()
        no(new Error(ERROR))
      }, 5000)
    })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let value: unknown
    try {
      const pending = request(`${DEV_SERVER_URL}/api/auth/email-otp/send-verification-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: DEV_SERVER_URL },
        body: JSON.stringify(
          requestIndex <= 4
            ? { type: 'sign-in' }
            : { type: 'sign-in', callbackURL: 'https://rejected.acme.example' }
        ),
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })
      // A late fetch must not retain an unread body after its deadline.
      void pending.then(
        (late) => {
          if (controller.signal.aborted) void late.body?.cancel().catch(() => {})
        },
        () => {}
      )
      const response = await Promise.race([pending, deadline]).catch(() => fail('request'))
      status = response.status
      elapsed()
      if (response.redirected || !response.body) fail('response')
      reader = response.body!.getReader()
      try {
        const chunks: Uint8Array[] = []
        let bytes = 0
        for (;;) {
          const part = await Promise.race([reader.read(), deadline])
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > 4096) fail('response')
          chunks.push(part.value)
        }
        const body = new Uint8Array(bytes)
        let offset = 0
        for (const chunk of chunks) {
          body.set(chunk, offset)
          offset += chunk.byteLength
        }
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
      } catch {
        fail('response')
      }
      elapsed()
    } finally {
      clearTimeout(timer)
      controller.abort()
      // Cancellation is best effort and is never another unbounded await.
      if (reader) {
        void reader.cancel().catch(() => {})
        try {
          reader.releaseLock()
        } catch {
          /* Pending reads are already deadline-bound. */
        }
      }
    }
    const payload = value as { code?: unknown; message?: unknown } | null
    code =
      payload?.code === 'VALIDATION_ERROR' || payload?.code === 'INVALID_CALLBACK_URL'
        ? payload.code
        : 'OTHER'
    if (requestIndex <= 4) {
      if (
        status !== 400 ||
        code !== 'VALIDATION_ERROR' ||
        typeof payload?.message !== 'string' ||
        !payload.message.includes('[body.email]')
      )
        fail('validation')
    } else if (status !== 403 || code !== 'INVALID_CALLBACK_URL') fail('origin')
  }
  return { requests: 4, elapsed_ms: elapsed(), origin_rejected: true }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const io = runtimeIO()
  try {
    if (process.argv[2] === 'start') {
      const expected = resolve(process.env.RUNNER_TEMP!, 'e2e-evidence/image-server-image.id')
      if (process.argv[3] !== expected) throw new Error(ERROR)
      await startImageServer(io.read('image-server-image.id')?.trim() ?? '', io)
    } else if (process.argv[2] === 'finish') {
      finishImageServer(io)
    } else throw new Error(ERROR)
  } catch (error) {
    // Child stderr, configuration and tokens never enter failure metadata.
    try {
      const operation = process.argv[2] === 'finish' ? 'finish' : 'start'
      io.write(`image-server-${operation}-failure.json`, {
        schema: 1,
        operation,
        failed: true,
        ...(error instanceof ImageServerProbeError ? { probe: error.receipt } : {}),
      })
    } catch {
      /* The failing CI step remains authoritative if evidence storage also fails. */
    }
    console.error(ERROR)
    process.exit(1)
  }
}
