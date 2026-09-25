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
 *
 * POST bodies are sent as raw bytes (a Buffer). Given a string `data` and
 * `content-type: application/json`, Playwright JSON-encodes any string that
 * is not valid JSON, so `{not json` would reach the server as the valid JSON
 * string `"{not json"` and an empty body as `""`.
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

function devFunctionId(file: string, exportName: string): string {
  return Buffer.from(
    JSON.stringify({
      file,
      export: exportName,
    }),
    'utf8'
  ).toString('base64url')
}

let fnUrls: Promise<{ get: string; post: string }> | undefined

async function resolveFnUrls(request: APIRequestContext): Promise<{ get: string; post: string }> {
  try {
    const res = await request.get(FUNCTIONS_MODULE, { timeout: 5_000 })
    if (res.status() === 200) {
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
      if (get && post) {
        return { get: `/_serverFn/${get}`, post: `/_serverFn/${post}` }
      }
    }
  } catch {
    // Dev server does not serve module directly; fallback to deterministic dev id.
  }

  const get = devFunctionId(`${FUNCTIONS_MODULE}?tss-serverfn-split`, GET_EXPORT)
  const post = devFunctionId(`${FUNCTIONS_MODULE}?tss-serverfn-split`, POST_EXPORT)
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
        // Raw bytes: see the file header.
        data: Buffer.from(body, 'utf8'),
      })
      await expectBadRequest(res, `POST ${label}`)
    })
  }
})

async function expectNotFound(
  res: Awaited<ReturnType<APIRequestContext['get']>>,
  label: string
): Promise<void> {
  const body = await res.text()
  expect(res.status(), `${label}: status (body: ${body.slice(0, 200)})`).toBe(404)
  expect(body, `${label}: body`).toBe('Not Found')
  expect(res.headers()['x-tss-serialized'], `${label}: not a serialized error`).toBeUndefined()
  expect(res.headers()['content-type'] ?? '', `${label}: content type`).toContain('text/plain')
}

/**
 * Before this guard an id that names no function threw out of the framework
 * before its `try`, and h3 answered 500 `{"status":500,"unhandled":true,
 * "message":"HTTPError"}` (feedback.venturi.systems, 2026-09-24). So did the
 * bare `/_serverFn/`, even with no RPC headers at all. An id that names an
 * Object.prototype member, such as `constructor`, also answered 500 there
 * (2026-09-25T00:06:49Z): the resolver finds the inherited member and throws
 * `serverFnInfo.importer is not a function`, which is not an unknown-id error.
 */
test.describe('Server-function ids that name no function (DEF-59)', () => {
  const unknownIds: Array<[string, string]> = [
    ['an id that is not a function id', 'not-a-real-server-fn'],
    [
      'a well-formed dev id for an export that does not exist',
      devFunctionId(
        `${FUNCTIONS_MODULE}?tss-serverfn-split`,
        'noSuchExport_createServerFn_handler'
      ),
    ],
  ]
  for (const [label, id] of unknownIds) {
    test(`GET with ${label} answers 404`, async ({ request }) => {
      const res = await request.get(`/_serverFn/${id}`, { headers: RPC_HEADERS })
      await expectNotFound(res, `GET ${label}`)
    })

    test(`POST with ${label} answers 404`, async ({ request }) => {
      const res = await request.post(`/_serverFn/${id}`, {
        headers: { ...RPC_HEADERS, 'content-type': 'application/json' },
        data: JSON.stringify(LIST_ALL),
      })
      await expectNotFound(res, `POST ${label}`)
    })
  }

  test('a cross-site request to an unknown id is still refused 403 by CSRF first', async ({
    request,
  }) => {
    const res = await request.get('/_serverFn/not-a-real-server-fn', {
      headers: { 'x-tsr-serverFn': 'true', 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status()).toBe(403)
  })

  // The dev id validator reads `serverFnsById[id]` from a plain object (the
  // production resolver reads `manifest[id]` the same way), so these ids find
  // an inherited Object.prototype member instead of reporting an unknown id.
  // The guard answers them 404 before the framework resolves anything.
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    test(`GET with the Object.prototype member id ${id} answers 404`, async ({ request }) => {
      const res = await request.get(`/_serverFn/${id}`, { headers: RPC_HEADERS })
      await expectNotFound(res, `GET ${id}`)
    })
  }

  test('POST with the Object.prototype member id constructor answers 404', async ({ request }) => {
    const res = await request.post('/_serverFn/constructor', {
      headers: { ...RPC_HEADERS, 'content-type': 'application/json' },
      data: JSON.stringify(LIST_ALL),
    })
    await expectNotFound(res, 'POST constructor')
  })

  test('a cross-site request to a prototype-member id is still refused 403 by CSRF first', async ({
    request,
  }) => {
    const res = await request.get('/_serverFn/constructor', {
      headers: { 'x-tsr-serverFn': 'true', 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status()).toBe(403)
  })

  test('the bare /_serverFn/ answers 404 with RPC headers', async ({ request }) => {
    const res = await request.get('/_serverFn/', { headers: RPC_HEADERS })
    await expectNotFound(res, 'GET /_serverFn/ with RPC headers')
  })

  test('the bare /_serverFn/ answers 404 with no headers', async ({ request }) => {
    const get = await request.get('/_serverFn/')
    await expectNotFound(get, 'GET /_serverFn/')
    const post = await request.post('/_serverFn/', { data: '' })
    await expectNotFound(post, 'POST /_serverFn/')
  })

  test('a known id still resolves after the unknown-id checks', async ({ request }) => {
    const { get } = await urls(request)
    const res = await request.get(
      `${get}?payload=${encodeURIComponent(JSON.stringify(LIST_ALL))}`,
      { headers: RPC_HEADERS }
    )
    expect(res.status()).toBe(200)
    expect(res.headers()['x-tss-serialized']).toBe('true')
  })
})
