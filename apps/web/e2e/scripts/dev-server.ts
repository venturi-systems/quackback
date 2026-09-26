#!/usr/bin/env bun
/**
 * Playwright's webServer command for the end-to-end suite (HYG-35):
 *
 *   bun e2e/scripts/dev-server.ts
 *
 * Starts the dev server exactly as Playwright used to (`bun run dev`), prints
 * DEV_SERVER_READY_LINE on stderr once the tenant URL answers, and exits with
 * the dev server's exit code. dev-server-ready.ts explains why Playwright's
 * own probe of the URL is not enough on its own.
 */
import { DEV_SERVER_URL, startDevServer } from './dev-server-ready'

const run = startDevServer({
  command: 'bun',
  args: ['run', 'dev'],
  url: DEV_SERVER_URL,
  log: (line) => console.error(line),
})

// Playwright stops the server by signalling this process group; forward a
// signal sent to this process alone as well.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => run.child.kill(signal))
}

// Exit as soon as the dev server does, without waiting for an attempt in flight.
process.exit(await run.exit)
