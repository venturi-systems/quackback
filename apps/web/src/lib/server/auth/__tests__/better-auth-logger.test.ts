/**
 * DEF-66: Better Auth's own log calls never write a failed query's bound
 * values, to the console or to the app log.
 *
 * Without a `logger.log` option, @better-auth/core 1.6.33 writes each call to
 * the console with the raw error attached, and several routes pass it a
 * drizzle-orm DrizzleQueryError (`Failed query: <sql>\nparams: <values>`).
 * These tests build a real Better Auth instance with the option this app
 * passes (`betterAuthLoggerOptions`), take its own context logger, and call it
 * with the argument shapes those routes use. Each call must arrive in the app
 * logger's capture stream reduced to the safe shape, and nothing may reach the
 * console.
 */
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { DrizzleQueryError } from 'drizzle-orm'
import { DATABASE_ERROR_LOG_MESSAGE } from '@quackback/logger'
import { createLogger } from '@/lib/server/logger'
import { betterAuthLoggerOptions } from '../better-auth-logger'

const SESSION_TOKEN = 'sess_tok_SECRET_9e1f'
const OAUTH_EMAIL = 'ann@acme.example'
const STATEMENT = 'select "id", "token" from "session" where "session"."token" = $1'

/** Texts that must never appear in any emitted line or console call. */
const SECRETS = [SESSION_TOKEN, OAUTH_EMAIL, 'Failed query', 'params:']

function failedQuery(): DrizzleQueryError {
  return new DrizzleQueryError(
    STATEMENT,
    [SESSION_TOKEN, OAUTH_EMAIL],
    Object.assign(new Error('relation "session" does not exist'), {
      code: '42P01',
      severity: 'ERROR',
    })
  )
}

function capture() {
  const lines: string[] = []
  const log = createLogger({ level: 'trace', destination: { write: (s: string) => lines.push(s) } })
  return { log, lines, parsed: () => lines.map((line) => JSON.parse(line)) }
}

function consoleSpies() {
  return (['error', 'warn', 'log', 'info', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {})
  )
}

/** Everything the spied console methods were called with, as text. */
function consoleText(spies: ReturnType<typeof consoleSpies>): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((call) => call.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' '))
    .join('\n')
}

/**
 * A real Better Auth instance's own context logger, built with the app's
 * logger option. Anything Better Auth logs while it starts up is dropped from
 * the capture, and the console spies go in only afterwards, so each test sees
 * just the lines its own call produced.
 */
async function authLogger(sink: ReturnType<typeof capture>) {
  const appLog = sink.log
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'better-auth-logger-test-secret-0123456789abcdef',
    database: memoryAdapter({}),
    telemetry: { enabled: false },
    logger: betterAuthLoggerOptions(appLog),
  })
  const logger = (await auth.$context).logger
  sink.lines.length = 0
  return { logger, spies: consoleSpies() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Better Auth log calls (DEF-66)', () => {
  it('writes get-session\'s ("INTERNAL_SERVER_ERROR", error) through the app logger', async () => {
    const sink = capture()
    const { logger, spies } = await authLogger(sink)

    // api/routes/session.mjs:258
    logger.error('INTERNAL_SERVER_ERROR', failedQuery())

    expect(sink.lines).toHaveLength(1)
    for (const secret of SECRETS) expect(sink.lines[0]).not.toContain(secret)
    expect(sink.parsed()[0]).toMatchObject({
      level: 'error',
      msg: 'INTERNAL_SERVER_ERROR',
      err: {
        type: 'DrizzleQueryError',
        message: DATABASE_ERROR_LOG_MESSAGE,
        statement: STATEMENT,
        param_count: 2,
      },
    })
    expect(consoleText(spies)).toBe('')
  })

  it('writes an error passed as the message (session.mjs:397) with no message of its own', async () => {
    const sink = capture()
    const { logger, spies } = await authLogger(sink)

    // Better Auth types the message as a string, but its compiled route
    // passes the error itself (`ctx.context.logger.error(e)`), so this call
    // reproduces that at runtime.
    logger.error(failedQuery() as unknown as string)

    expect(sink.lines).toHaveLength(1)
    for (const secret of SECRETS) expect(sink.lines[0]).not.toContain(secret)
    const [line] = sink.parsed()
    expect(line.msg).toBe(DATABASE_ERROR_LOG_MESSAGE)
    expect(line.err).toMatchObject({ type: 'DrizzleQueryError', statement: STATEMENT })
    expect(consoleText(spies)).toBe('')
  })

  it("cuts a failed query's text out of a message string (the router's onError)", async () => {
    const sink = capture()
    const { logger, spies } = await authLogger(sink)

    // api/index.mjs:205-207 logs e.message alone when it names a relation.
    logger.error(failedQuery().message)

    expect(sink.lines).toHaveLength(1)
    for (const secret of SECRETS) expect(sink.lines[0]).not.toContain(secret)
    expect(consoleText(spies)).toBe('')
  })

  it("writes link-account's database failure (link-account.mjs:12) without the email", async () => {
    const sink = capture()
    const { logger, spies } = await authLogger(sink)

    logger.error('Better auth was unable to query your database.\nError: ', failedQuery())

    expect(sink.lines).toHaveLength(1)
    for (const secret of SECRETS) expect(sink.lines[0]).not.toContain(secret)
    expect(sink.parsed()[0].err).toMatchObject({ type: 'DrizzleQueryError', param_count: 2 })
    expect(consoleText(spies)).toBe('')
  })

  it('keeps an ordinary error and extra arguments, at the level Better Auth used', async () => {
    const sink = capture()
    const { logger, spies } = await authLogger(sink)

    logger.warn('Could not update user info on account link', new Error('provider timeout'), {
      providerId: 'github',
    })

    const [line] = sink.parsed()
    expect(line).toMatchObject({
      level: 'warn',
      msg: 'Could not update user info on account link',
      err: { message: 'provider timeout' },
      args: [{ providerId: 'github' }],
    })
    expect(consoleText(spies)).toBe('')
  })

  it('sets no level, which would turn on the router onError console logger', () => {
    // api/index.mjs:201-202 logs e.message to the module-level console logger
    // whenever options.logger.level is 'error', 'warn' or 'debug'.
    expect(betterAuthLoggerOptions(capture().log)).not.toHaveProperty('level')
  })

  it('is the logger option the app passes to betterAuth()', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const call = source.indexOf('betterAuth({')
    expect(call).toBeGreaterThan(-1)
    expect(source.indexOf('logger: betterAuthLoggerOptions(', call)).toBeGreaterThan(call)
  })
})
