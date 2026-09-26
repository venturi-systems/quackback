/**
 * DEF-66 residuals: a failed query that a Better Auth request does not catch
 * never reaches the console, through a real Better Auth instance.
 *
 * Two console paths are left after Better Auth's own log calls go through the
 * app logger (better-auth-logger.test.ts):
 *
 * - better-call 1.4.0 `dist/router.mjs:93` prints any error an endpoint throws
 *   that is not an `APIError`: `console.error('# SERVER_ERROR: ', error)`.
 *   The app's `onAPIError` option rethrows such an error and
 *   `answerAuthRequest` logs it through the app logger instead.
 * - @better-auth/core 1.6.33 `dist/db/adapter/factory.mjs:385` prints the
 *   failed query when a fallback join fails: `console.error(error)`. The
 *   server routes the console through the app logger (`routeConsoleToLogger`).
 *
 * Each test drives a real Better Auth instance over the memory adapter, whose
 * `user` table throws drizzle-orm's `DrizzleQueryError` (`Failed query: <sql>
 * \nparams: <values>`) with an email and a session token bound, and checks
 * both the console and the app logger's capture stream. The control cases,
 * without the app's options, show the console path each fix closes.
 */
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { DrizzleQueryError } from 'drizzle-orm'
import { DATABASE_ERROR_LOG_MESSAGE, routeConsoleToLogger } from '@quackback/logger'
import { createLogger } from '@/lib/server/logger'
import {
  answerAuthRequest,
  betterAuthApiErrorOptions,
  betterAuthLoggerOptions,
} from '../better-auth-logger'

const ORIGIN = 'http://localhost:3000'
const SESSION_TOKEN = 'sess_tok_SECRET_7c2a'
const EMAIL = 'ann@acme.example'
const STATEMENT = 'select "id", "email" from "user" where "user"."email" = $1'

/** Texts that must never appear in any emitted line or console call. */
const SECRETS = [SESSION_TOKEN, EMAIL, 'Failed query', 'params:']

function failedQuery(): DrizzleQueryError {
  return new DrizzleQueryError(
    STATEMENT,
    [EMAIL, SESSION_TOKEN],
    Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
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

/** A memory store whose `user` table fails as a database under load would. */
function storeWithFailingUserTable(): Record<string, unknown[]> {
  const store: Record<string, unknown[]> = { session: [], account: [], verification: [] }
  Object.defineProperty(store, 'user', {
    enumerable: true,
    get() {
      throw failedQuery()
    },
  })
  return store
}

/**
 * A real Better Auth instance with the app's logger option and, unless
 * `appOptions` is false, the app's `onAPIError` option. Lines Better Auth
 * logs while it starts are dropped, and the console spies go in afterwards.
 */
async function createTestAuth(sink: ReturnType<typeof capture>, appOptions = true) {
  const auth = betterAuth({
    baseURL: ORIGIN,
    secret: 'better-auth-console-test-secret-0123456789abcdef',
    database: memoryAdapter(storeWithFailingUserTable()),
    telemetry: { enabled: false },
    // Better Auth skips its origin check under a test runner; keep it on, as in production.
    advanced: { disableOriginCheck: false },
    emailAndPassword: { enabled: true },
    logger: betterAuthLoggerOptions(sink.log),
    ...(appOptions ? { onAPIError: betterAuthApiErrorOptions(sink.log) } : {}),
  })
  const context = await auth.$context
  sink.lines.length = 0
  return { auth, context, spies: consoleSpies() }
}

/** Email sign-in: the route looks the email up and catches nothing. */
function signInRequest(): Request {
  return new Request(`${ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: 'correct horse battery staple' }),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an uncaught failed query in a Better Auth request (DEF-66, router onError)', () => {
  it('control: without the onAPIError option, better-call prints it raw', async () => {
    const sink = capture()
    const { auth, spies } = await createTestAuth(sink, false)

    const response = await auth.handler(signInRequest())

    expect(response.status).toBe(500)
    const printed = consoleText(spies)
    expect(printed).toContain('# SERVER_ERROR')
    expect(printed).toContain(EMAIL)
  })

  it('is logged through the app logger and answered 500, with nothing on the console', async () => {
    const sink = capture()
    const { auth, spies } = await createTestAuth(sink)
    const request = signInRequest()

    const response = await answerAuthRequest(sink.log, request, () => auth.handler(request))

    expect(response.status).toBe(500)
    expect(response.statusText).toBe('Internal Server Error')
    expect(await response.text()).toBe('')
    expect(consoleText(spies)).toBe('')
    expect(sink.lines).toHaveLength(1)
    for (const secret of SECRETS) expect(sink.lines[0]).not.toContain(secret)
    expect(sink.parsed()[0]).toMatchObject({
      level: 'error',
      msg: 'auth request failed',
      method: 'POST',
      err: {
        type: 'DrizzleQueryError',
        message: DATABASE_ERROR_LOG_MESSAGE,
        statement: STATEMENT,
        param_count: 2,
        pg_code: '57014',
      },
    })
  })

  it('still answers an APIError with its own response, and prints nothing', async () => {
    const sink = capture()
    const { auth, spies } = await createTestAuth(sink)
    const request = new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: 'not an email', password: 'x' }),
    })

    const response = await answerAuthRequest(sink.log, request, () => auth.handler(request))

    expect(response.status).toBe(400)
    expect(consoleText(spies)).toBe('')
  })
})

describe('betterAuthApiErrorOptions', () => {
  it('rethrows an error that is not an APIError, unchanged', () => {
    const { onError } = betterAuthApiErrorOptions(capture().log)
    const error = failedQuery()

    expect(() => onError(error)).toThrow(error)
  })

  it("logs an internal-server-error APIError as Better Auth's default does", () => {
    const sink = capture()
    const { onError } = betterAuthApiErrorOptions(sink.log)

    onError(new APIError('INTERNAL_SERVER_ERROR', { message: 'session store unavailable' }))
    onError(new APIError('BAD_REQUEST', { message: 'Invalid email' }))

    expect(sink.lines).toHaveLength(1)
    expect(sink.parsed()[0]).toMatchObject({
      level: 'error',
      msg: 'INTERNAL_SERVER_ERROR',
      err: { message: 'session store unavailable' },
    })
  })

  it('logs an APIError that names a schema object by its message alone, as the default does', () => {
    const sink = capture()
    const { onError } = betterAuthApiErrorOptions(sink.log)

    onError(new APIError('BAD_REQUEST', { message: 'relation "session" does not exist' }))

    expect(sink.parsed()).toMatchObject([
      { level: 'error', msg: 'relation "session" does not exist' },
    ])
  })
})

describe('a failed fallback join (DEF-66, @better-auth/core factory.mjs:385)', () => {
  /** A session whose user lookup, the fallback join, fails. */
  async function findSessionWithFailingJoin(
    context: Awaited<ReturnType<typeof createTestAuth>>['context']
  ) {
    const session = await context.internalAdapter.createSession('user_1')
    return context.internalAdapter.findSession(session.token)
  }

  it('control: without the console routed, the failed query is printed raw', async () => {
    const sink = capture()
    const { context, spies } = await createTestAuth(sink)

    await expect(findSessionWithFailingJoin(context)).rejects.toBeInstanceOf(DrizzleQueryError)

    expect(consoleText(spies)).toContain(EMAIL)
  })

  it('is written through the app logger when the console is routed', async () => {
    const sink = capture()
    const { context, spies } = await createTestAuth(sink)
    const restore = routeConsoleToLogger(sink.log)
    try {
      await expect(findSessionWithFailingJoin(context)).rejects.toBeInstanceOf(DrizzleQueryError)
    } finally {
      restore()
    }

    expect(consoleText(spies)).toBe('')
    expect(sink.lines.length).toBeGreaterThan(0)
    for (const line of sink.lines) {
      for (const secret of SECRETS) expect(line).not.toContain(secret)
    }
    expect(sink.parsed()).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: DATABASE_ERROR_LOG_MESSAGE,
        err: expect.objectContaining({ type: 'DrizzleQueryError', statement: STATEMENT }),
      })
    )
  })
})

describe('the app wires both fixes', () => {
  it('passes the onAPIError option to betterAuth()', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const call = source.indexOf('betterAuth({')
    expect(call).toBeGreaterThan(-1)
    expect(source.indexOf('onAPIError: betterAuthApiErrorOptions(', call)).toBeGreaterThan(call)
  })

  it('answers every auth request through answerAuthRequest', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const handler = source.indexOf('async handler(request: Request)')
    expect(handler).toBeGreaterThan(-1)
    expect(source.indexOf('return answerAuthRequest(', handler)).toBeGreaterThan(handler)
  })

  it('routes the production server console through the app logger', () => {
    const source = readFileSync(new URL('../../../../server.ts', import.meta.url), 'utf8')
    const guard = source.indexOf("if (process.env.NODE_ENV === 'production') {")
    expect(guard).toBeGreaterThan(-1)
    expect(source.indexOf('routeConsoleToLogger(', guard)).toBeGreaterThan(guard)
  })
})
