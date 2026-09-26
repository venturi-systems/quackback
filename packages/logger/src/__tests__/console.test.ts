/**
 * DEF-63, DEF-66: a console call never writes a failed query's bound values.
 *
 * Dependencies of the web server print raw errors to the console (better-call's
 * `console.error('# SERVER_ERROR: ', error)`, Better Auth's fallback join
 * `console.error(error)`). `routeConsoleToLogger` writes each console call
 * through the real `createLogger` instead. These tests route a stand-in
 * console, so the test runner's own console is never replaced, and inspect
 * both the emitted JSON and what reached the original console methods.
 */
import { describe, expect, it, vi } from 'vitest'
import { CONSOLE_CALL_NOT_LOGGED, routeConsoleToLogger, writeLogCall } from '../console'
import { DATABASE_ERROR_LOG_MESSAGE, WITHHELD_QUERY_TEXT } from '../error-serializer'
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

const SECRET_TOKEN = 'sess_tok_SECRET_51c0'
const SECRET_EMAIL = 'ann@acme.example'
const STATEMENT = 'select "id" from "user" where "email" = $1 and "token" = $2'

/** Texts that must never appear in an emitted line or an original console call. */
const SECRETS = [SECRET_TOKEN, SECRET_EMAIL, 'Failed query', 'params:']

function failedQuery(): DrizzleQueryError {
  const cause = Object.assign(new Error('canceling statement due to statement timeout'), {
    code: '57014',
    severity: 'ERROR',
  })
  return new DrizzleQueryError(STATEMENT, [SECRET_EMAIL, SECRET_TOKEN], cause)
}

function capture() {
  const lines: string[] = []
  const log = createLogger({ level: 'trace', destination: { write: (s: string) => lines.push(s) } })
  return { log, lines, parsed: () => lines.map((line) => JSON.parse(line)) }
}

const METHODS = ['error', 'warn', 'log', 'info', 'dir', 'debug', 'trace'] as const

/** A stand-in console whose every method is a spy. */
function fakeConsole() {
  const spies = Object.fromEntries(METHODS.map((method) => [method, vi.fn()])) as Record<
    (typeof METHODS)[number],
    ReturnType<typeof vi.fn>
  >
  return { target: { ...spies } as unknown as Console, spies }
}

function expectNoSecrets(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret)
}

describe('routeConsoleToLogger (DEF-63, DEF-66)', () => {
  it("writes better-call's console.error('# SERVER_ERROR: ', error) through the logger", () => {
    const sink = capture()
    const { target, spies } = fakeConsole()
    routeConsoleToLogger(sink.log, target)

    target.error('# SERVER_ERROR: ', failedQuery())

    expect(sink.lines).toHaveLength(1)
    expectNoSecrets(sink.lines[0])
    expect(sink.parsed()[0]).toMatchObject({
      level: 'error',
      msg: '# SERVER_ERROR: ',
      err: {
        type: 'DrizzleQueryError',
        message: DATABASE_ERROR_LOG_MESSAGE,
        statement: STATEMENT,
        param_count: 2,
      },
    })
    expect(spies.error).not.toHaveBeenCalled()
  })

  it("writes Better Auth's fallback-join console.error(error) with the logger's own message", () => {
    const sink = capture()
    const { target, spies } = fakeConsole()
    routeConsoleToLogger(sink.log, target)

    target.error(failedQuery())

    expect(sink.lines).toHaveLength(1)
    expectNoSecrets(sink.lines[0])
    const [line] = sink.parsed()
    expect(line.msg).toBe(DATABASE_ERROR_LOG_MESSAGE)
    expect(line.err).toMatchObject({ type: 'DrizzleQueryError', statement: STATEMENT })
    expect(spies.error).not.toHaveBeenCalled()
  })

  it("cuts a failed query's text out of a logged string, and sanitizes other arguments", () => {
    const sink = capture()
    const { target } = fakeConsole()
    routeConsoleToLogger(sink.log, target)

    target.log(failedQuery().message, { query: failedQuery() })

    expect(sink.lines).toHaveLength(1)
    expectNoSecrets(sink.lines[0])
    const [line] = sink.parsed()
    expect(line.msg).toBe(WITHHELD_QUERY_TEXT)
    expect(line.args[0].query).toMatchObject({ type: 'DrizzleQueryError', param_count: 2 })
  })

  it('writes each console method at its level and leaves ordinary calls readable', () => {
    const sink = capture()
    const { target, spies } = fakeConsole()
    routeConsoleToLogger(sink.log, target)

    for (const method of METHODS) {
      const call = target[method] as (...args: unknown[]) => void
      call(`${method} call`, { n: 1 })
    }

    expect(sink.parsed().map((line) => [line.level, line.msg, line.args])).toEqual([
      ['error', 'error call', [{ n: 1 }]],
      ['warn', 'warn call', [{ n: 1 }]],
      ['info', 'log call', [{ n: 1 }]],
      ['info', 'info call', [{ n: 1 }]],
      ['info', 'dir call', [{ n: 1 }]],
      ['debug', 'debug call', [{ n: 1 }]],
      ['debug', 'trace call', [{ n: 1 }]],
    ])
    for (const method of METHODS) expect(spies[method]).not.toHaveBeenCalled()
  })

  it('writes a fixed line through the original method when the logger throws', () => {
    const { target, spies } = fakeConsole()
    const broken = {
      error: () => {
        throw new Error('destination closed')
      },
    } as unknown as AppLogger
    routeConsoleToLogger(broken, target)

    target.error('# SERVER_ERROR: ', failedQuery())

    expect(spies.error).toHaveBeenCalledTimes(1)
    expect(spies.error).toHaveBeenCalledWith(CONSOLE_CALL_NOT_LOGGED)
  })

  it('writes a fixed line for a console call made while another is being written', () => {
    const { target, spies } = fakeConsole()
    const lines: string[] = []
    let reentered = false
    const log = createLogger({
      level: 'trace',
      destination: {
        write: (s: string) => {
          lines.push(s)
          if (!reentered) {
            reentered = true
            target.error(failedQuery())
          }
        },
      },
    })
    routeConsoleToLogger(log, target)

    target.warn('first')

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).msg).toBe('first')
    expect(spies.error).toHaveBeenCalledTimes(1)
    expect(spies.error).toHaveBeenCalledWith(CONSOLE_CALL_NOT_LOGGED)
  })

  it('puts the original methods back', () => {
    const { target, spies } = fakeConsole()
    const restore = routeConsoleToLogger(capture().log, target)
    expect(target.error).not.toBe(spies.error)

    restore()

    for (const method of METHODS) expect(target[method]).toBe(spies[method])
  })
})

describe('writeLogCall', () => {
  it('logs the first error as err, the rest under args, with a string message', () => {
    const sink = capture()
    const other = new Error('second')

    writeLogCall(sink.log, 'warn', 'lookup failed', [failedQuery(), other, undefined, 7])

    expectNoSecrets(sink.lines[0])
    const [line] = sink.parsed()
    expect(line).toMatchObject({ level: 'warn', msg: 'lookup failed', err: { param_count: 2 } })
    expect(line.args).toHaveLength(2)
    expect(line.args[0]).toMatchObject({ message: 'second' })
    expect(line.args[1]).toBe(7)
  })

  it('writes an empty message, never the error text, when the message is not a string', () => {
    const sink = capture()

    writeLogCall(sink.log, 'error', { step: 'join' }, [failedQuery()])

    expectNoSecrets(sink.lines[0])
    expect(sink.parsed()[0]).toMatchObject({ msg: '', args: [{ step: 'join' }] })
  })
})
