/**
 * DEF-63 class: an unhandled rejection or an uncaught exception never writes a
 * failed query's bound values.
 *
 * The runtime reports these itself, not through the console, so
 * `routeConsoleToLogger` never sees them. `routeProcessErrorsToLogger` writes
 * each through the real `createLogger` at `fatal` and then exits with code 1,
 * as the runtime would have. These tests route a stand-in process, so the test
 * runner's own process listeners and exit are never touched.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PROCESS_ERROR_NOT_LOGGED,
  UNCAUGHT_EXCEPTION_MESSAGE,
  UNHANDLED_REJECTION_MESSAGE,
  routeProcessErrorsToLogger,
} from '../process-errors'
import { createLogger, type AppLogger } from '../logger'

/** drizzle-orm 0.45.2 `DrizzleQueryError`, constructor copied as it is. */
class DrizzleQueryError extends Error {
  query: string
  params: unknown[]
  constructor(query: string, params: unknown[], cause?: Error) {
    super(`Failed query: ${query}\nparams: ${params}`)
    this.query = query
    this.params = params
    this.cause = cause
    Error.captureStackTrace(this, DrizzleQueryError)
    if (cause) this.cause = cause
  }
}

const SECRET_TOKEN = 'sess_tok_SECRET_7d21'
const SECRET_EMAIL = 'ann@acme.example'
const STATEMENT = 'INSERT INTO sweep_lock (name, acquired_at) VALUES ($1, now()) RETURNING $2'

/** Texts that must never appear in an emitted line or on stderr. */
const SECRETS = [SECRET_TOKEN, SECRET_EMAIL, 'Failed query', 'params:']

function failedQuery(): DrizzleQueryError {
  const cause = Object.assign(new Error('connection terminated unexpectedly'), {
    code: '57P01',
    severity: 'FATAL',
  })
  return new DrizzleQueryError(STATEMENT, [SECRET_EMAIL, SECRET_TOKEN], cause)
}

function capture() {
  const lines: string[] = []
  const log = createLogger({ level: 'trace', destination: { write: (s: string) => lines.push(s) } })
  return { log, lines, parsed: () => lines.map((line) => JSON.parse(line)) }
}

type Listener = (reason: unknown) => void

/** A stand-in process: records listeners, exit codes and stderr writes. */
function fakeProcess() {
  const listeners = new Map<string, Listener[]>()
  const exit = vi.fn()
  const stderrWrite = vi.fn()
  const target = {
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return target
    },
    off(event: string, listener: Listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener))
      return target
    },
    exit,
    stderr: { write: stderrWrite },
  }
  const emit = (event: string, reason: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(reason)
  }
  const count = (event: string) => (listeners.get(event) ?? []).length
  return { target: target as unknown as NodeJS.Process, emit, count, exit, stderrWrite }
}

function expectNoSecrets(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret)
}

describe('routeProcessErrorsToLogger', () => {
  it('writes an unhandled rejection at fatal without its SQL or values, then exits 1', () => {
    const { log, lines, parsed } = capture()
    const proc = fakeProcess()
    routeProcessErrorsToLogger(log, proc.target)

    proc.emit('unhandledRejection', failedQuery())

    expect(lines).toHaveLength(1)
    const [line] = parsed()
    expect(line.level).toBe('fatal')
    expect(line.msg).toBe(UNHANDLED_REJECTION_MESSAGE)
    expect(line.err).toBeDefined()
    expectNoSecrets(lines[0])
    expect(proc.exit).toHaveBeenCalledOnce()
    expect(proc.exit).toHaveBeenCalledWith(1)
    expect(proc.stderrWrite).not.toHaveBeenCalled()
  })

  it('writes an uncaught exception at fatal without its SQL or values, then exits 1', () => {
    const { log, lines, parsed } = capture()
    const proc = fakeProcess()
    routeProcessErrorsToLogger(log, proc.target)

    proc.emit('uncaughtException', failedQuery())

    expect(lines).toHaveLength(1)
    const [line] = parsed()
    expect(line.level).toBe('fatal')
    expect(line.msg).toBe(UNCAUGHT_EXCEPTION_MESSAGE)
    expectNoSecrets(lines[0])
    expect(proc.exit).toHaveBeenCalledWith(1)
  })

  it('cuts a failed query out of a rejection reason that is a string', () => {
    const { log, lines } = capture()
    const proc = fakeProcess()
    routeProcessErrorsToLogger(log, proc.target)

    proc.emit(
      'unhandledRejection',
      `Failed query: ${STATEMENT}\nparams: ${SECRET_EMAIL},${SECRET_TOKEN}`
    )

    expect(lines).toHaveLength(1)
    expectNoSecrets(lines[0])
    expect(proc.exit).toHaveBeenCalledWith(1)
  })

  it('writes only a fixed notice to stderr when the logger throws, then exits 1', () => {
    const throwing = {
      fatal: () => {
        throw new Error('destination closed')
      },
    } as unknown as AppLogger
    const proc = fakeProcess()
    routeProcessErrorsToLogger(throwing, proc.target)

    proc.emit('unhandledRejection', failedQuery())

    expect(proc.stderrWrite).toHaveBeenCalledOnce()
    expect(proc.stderrWrite).toHaveBeenCalledWith(`${PROCESS_ERROR_NOT_LOGGED}\n`)
    expectNoSecrets(String(proc.stderrWrite.mock.calls[0]?.[0]))
    expect(proc.exit).toHaveBeenCalledWith(1)
  })

  it('does not write a second fatal error raised while the first is handled', () => {
    const { log, lines } = capture()
    const proc = fakeProcess()
    routeProcessErrorsToLogger(log, proc.target)

    proc.emit('unhandledRejection', new Error('first'))
    proc.emit('uncaughtException', new Error('second'))

    expect(lines).toHaveLength(1)
    expect(proc.exit).toHaveBeenCalledTimes(2)
  })

  it('removes both listeners when the returned function is called', () => {
    const { log } = capture()
    const proc = fakeProcess()
    const restore = routeProcessErrorsToLogger(log, proc.target)
    expect(proc.count('unhandledRejection')).toBe(1)
    expect(proc.count('uncaughtException')).toBe(1)

    restore()

    expect(proc.count('unhandledRejection')).toBe(0)
    expect(proc.count('uncaughtException')).toBe(0)
  })
})
