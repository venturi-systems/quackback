import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { watchConfigFile } from '../watcher'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'config-file-watch-'))
  path = join(dir, 'config.yaml')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const validYaml = `apiVersion: quackback.io/v1
kind: QuackbackConfig
spec:
  workspace:
    name: Acme
`

// Wall-clock sleeps make these tests scheduling-sensitive: under a saturated
// box the initial tick or a 30ms poll can land far later than the sleep, so
// fixed waits raced the watcher and flaked. Wait for the observable condition
// with a deadline instead, then make the same assertions as before.
const WAITFOR = { timeout: 8000, interval: 10 }

describe('watchConfigFile', () => {
  it('fires onChange with the parsed config on first tick when the file exists', async () => {
    writeFileSync(path, validYaml)
    const events: unknown[] = []
    const stop = watchConfigFile(path, (r) => {
      events.push(r)
    })
    try {
      await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), WAITFOR)
    } finally {
      stop()
    }
    expect(events.length).toBeGreaterThanOrEqual(1)
    const last = events[events.length - 1] as { kind: string }
    expect(last.kind).toBe('ok')
  })

  it('fires onChange with kind=absent when the file does not exist on first tick', async () => {
    const events: unknown[] = []
    const stop = watchConfigFile(path, (r) => {
      events.push(r)
    })
    try {
      await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), WAITFOR)
    } finally {
      stop()
    }
    const last = events[events.length - 1] as { kind: string }
    expect(last.kind).toBe('absent')
  })

  it('dedupes consecutive identical loads (only fires onChange when content changes)', async () => {
    writeFileSync(path, validYaml)
    const events: unknown[] = []
    const stop = watchConfigFile(
      path,
      (r) => {
        events.push(r)
      },
      { pollIntervalMs: 30 }
    )
    try {
      // Deterministic anchor: the initial load has fired.
      await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), WAITFOR)
      // Let poll ticks re-read the identical content; deduped ticks must not
      // fire onChange again.
      await wait(150)
    } finally {
      stop()
    }
    expect(events.length).toBe(1)
  })

  it('fires again when content changes', async () => {
    writeFileSync(path, validYaml)
    const events: unknown[] = []
    const stop = watchConfigFile(
      path,
      (r) => {
        events.push(r)
      },
      { pollIntervalMs: 30 }
    )
    try {
      // Wait until the FIRST content was observed before changing it —
      // writing earlier would collapse both versions into one observation.
      await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), WAITFOR)
      writeFileSync(
        path,
        `apiVersion: quackback.io/v1\nkind: QuackbackConfig\nspec: { workspace: { name: Different } }\n`
      )
      await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2), WAITFOR)
    } finally {
      stop()
    }
    expect(events.length).toBe(2)
  })

  it('serializes onChange — no concurrent invocations even with rapid changes', async () => {
    writeFileSync(path, validYaml)
    let active = 0
    let maxActive = 0
    const onChange = async () => {
      active++
      if (active > maxActive) maxActive = active
      await wait(40)
      active--
    }
    const stop = watchConfigFile(path, onChange, { pollIntervalMs: 10 })
    // Trigger several near-simultaneous changes via writes.
    await wait(20)
    writeFileSync(
      path,
      `apiVersion: quackback.io/v1\nkind: QuackbackConfig\nspec: { workspace: { name: A } }\n`
    )
    await wait(5)
    writeFileSync(
      path,
      `apiVersion: quackback.io/v1\nkind: QuackbackConfig\nspec: { workspace: { name: B } }\n`
    )
    await wait(5)
    writeFileSync(
      path,
      `apiVersion: quackback.io/v1\nkind: QuackbackConfig\nspec: { workspace: { name: C } }\n`
    )
    await wait(200)
    stop()
    // Even with multiple change triggers, onChange must never run in
    // parallel — the in-flight gate guarantees serial calls.
    expect(maxActive).toBe(1)
  })
})

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
