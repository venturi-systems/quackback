import { test, expect, type APIRequestContext } from '@playwright/test'

/**
 * DEF-59 (landing-page#2309): a /_serverFn/ request whose payload cannot be
 * decoded must answer 400 with no error detail, never a 500 that echoes the
 * decoder's message.
 *
 * @tanstack/start-server-core 1.169.37 decodes the payload inside the same
 * `try` that runs the function and answers any failure 500. Production
 * (fork 8ed10c3) answered, on 2026-09-24:
 *   GET  ?payload=garbage        -> 500 "JSON Parse error: Unexpected identifier ..."
 *   GET  ?payload={"t":99}       -> 500 "Seroval Error (step: 3)"
 *   POST body `{not json`        -> 500 "JSON Parse error: Expected '}'"
 *   POST empty application/json  -> 500 "Unexpected end of JSON input"
 * The fork's decode guard (src/lib/server/middleware/serverfn-decode-guard.ts)
 * turns those into 400. This spec runs against the real server stack, so a
 * framework change that brings the 500 back, or a guard that starts touching
 * valid calls, fails here.
 *
 * Function ids come from the dev server's own client module: in dev each id
 * is base64url JSON naming the source file and the extracted export.
 */
const FUNCTIONS_MODULE = '/src/lib/server/functions/public-posts.ts'
const GET_EXPORT = 'listPublicPostsFn_createServerFn_handler'
const POST_EXPORT = 'toggleVoteFn_createServerFn_handler'

/** What the app's RPC client sends; Sec-Fetch-Site satisfies the CSRF middleware. */
const RPC_HEADERS = { 'x-tsr-serverFn': 'true', 'sec-fetch-site': 'same-origin' }

/** seroval envelopes (seroval 1.6.4 `toJSON`), as the app's RPC client sends them. */
const LIST_ALL = {
  t: { t: 10, i: 0, p: { k: ['data'], v: [{ t: 10, i: 1, p: { k: [], v: [] }, o: 0 }] }, o: 0 },
  f: 127,
  m: [],
}
const VOTE_MISSING_POST = {
  t: {
    t: 10,
    i: 0,
    p: {
      k: ['data'],
      v: [{ t: 10, i: 1, p: { k: ['postId'], v: [{ t: 1, s: 'post_e2e_missing' }] }, o: 0 }],
    },
    o: 0,
  },
  f: 127,
  m: [],
}
/** Well-formed envelope whose root is the number 1: decodes, but cannot carry a call. */
const PRIMITIVE_ROOT = { t: { t: 0, s: 1 }, f: 127, m: [] }

let fnUrls: Promise<{ get: string; post: string }> | undefined

async function resolveFnUrls(request: APIRequestContext): Promise<{ get: string; post: string }> {
  const res = await request.get(FUNCTIONS_MODULE, { timeout: 60_000 })
  expect(res.status(), `dev server module ${FUNCTIONS_MODULE}`).toBe(200)
  const source = await res.text()
  const ids = new Map<string, string>()
  for (const match of source.matchAll(/createClientRpc\(\s*["'`]([A-Za-z0-9_-]+)["'`]/g)) {
    try {
      const decoded = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as {
        export?: unknown
      }
      if (typeof decoded.export === 'string') ids.set(decoded.export, match[1])
    } catch {
      // Not a dev-mode id; ignore it.
    }
  }
  const get = ids.get(GET_EXPORT)
  const post = ids.get(POST_EXPORT)
  expect(
    get,
    `server-function id for ${GET_EXPORT}; found ${[...ids.keys()].join(', ')}`
  ).toBeTruthy()
  expect(
    post,
    `server-function id for ${POST_EXPORT}; found ${[...ids.keys()].join(', ')}`
  ).toBeTruthy()
  return { get: `/_serverFn/${get}`, post: `/_serverFn/${post}` }
}

function urls(request: APIRequestContext) {
  fnUrls ??= resolveFnUrls(request).catch((error) => {
    fnUrls = undefined
    throw error
  })
  return fnUrls
}

async function expectBadRequest(
  res: Awaited<ReturnType<APIRequestContext['get']>>,
  label: string
): Promise<void> {
  const body = await res.text()
  expect(res.status(), `${label}: status (body: ${body.slice(0, 200)})`).toBe(400)
  expect(body, `${label}: body`).toBe('Bad Request')
  expect(res.headers()['x-tss-serialized'], `${label}: not a serialized error`).toBeUndefined()
  expect(res.headers()['content-type'] ?? '', `${label}: content type`).toContain('text/plain')
}

test.describe('Server-function payloads that cannot be decoded (DEF-59)', () => {
  test('a valid GET call still answers 200 with a serialized result', async ({ request }) => {
    const { get } = await urls(request)
    const res = await request.get(
      `${get}?payload=${encodeURIComponent(JSON.stringify(LIST_ALL))}`,
      { headers: RPC_HEADERS }
    )
    expect(res.status()).toBe(200)
    expect(res.headers()['x-tss-serialized']).toBe('true')
  })

  test('a valid POST call is decoded and runs (its own auth error comes back serialized)', async ({
    request,
  }) => {
    const { post } = await urls(request)
    const res = await request.post(post, {
      headers: { ...RPC_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify(VOTE_MISSING_POST),
    })
    expect(res.status()).toBe(200)
    expect(res.headers()['x-tss-serialized']).toBe('true')
  })

  const getCases: Array<[string, string]> = [
    ['malformed JSON', 'garbage'],
    ['JSON that is not a seroval envelope', '{"t":99}'],
    ['an envelope whose root is a primitive', JSON.stringify(PRIMITIVE_ROOT)],
  ]
  for (const [label, payload] of getCases) {
    test(`GET with ${label} answers 400`, async ({ request }) => {
      const { get } = await urls(request)
      const res = await request.get(`${get}?payload=${encodeURIComponent(payload)}`, {
        headers: RPC_HEADERS,
      })
      await expectBadRequest(res, `GET ${label}`)
    })
  }

  const postCases: Array<[string, string]> = [
    ['malformed JSON', '{not json'],
    ['an empty body', ''],
    ['JSON that is not a seroval envelope', '{"t":99}'],
    [
      'an oversized (1.5 MB) body that is not a seroval envelope',
      JSON.stringify('a'.repeat(1_500_000)),
    ],
  ]
  for (const [label, body] of postCases) {
    test(`POST with ${label} answers 400`, async ({ request }) => {
      const { post } = await urls(request)
      const res = await request.post(post, {
        headers: { ...RPC_HEADERS, 'content-type': 'application/json' },
        data: body,
      })
      await expectBadRequest(res, `POST ${label}`)
    })
  }
})
