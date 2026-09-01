/**
 * Tests for database connection module
 *
 * Tests self-hosted mode with DATABASE_URL singleton connection.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

// Store original env
const originalEnv = { ...process.env }

// Set up minimal config for tests
function setupMinimalConfig() {
  process.env.DATABASE_URL = 'postgres://localhost/quackback'
  process.env.BASE_URL = 'http://localhost:3000'
  process.env.SECRET_KEY = 'test-secret-key-that-is-at-least-32-characters-long'
  process.env.REDIS_URL = 'redis://localhost:6379'
}

// Hoist the mock factory so it's available before module imports
const { mockCreateDb } = vi.hoisted(() => {
  const mockDb = { query: {}, _mock: true }
  return {
    mockCreateDb: vi.fn(() => mockDb),
  }
})

// Mock createDb
vi.mock('@quackback/db/client', () => ({
  createDb: mockCreateDb,
}))

describe('db module', () => {
  // Each test re-imports '../db' after vi.resetModules() — required for the
  // singleton contract under test. The FIRST fetch of that module graph is
  // the expensive part (transform + evaluation of the whole dependency
  // chain); pay it once here, outside any per-test timeout budget, so the
  // per-test re-imports are cheap re-executions of already-fetched modules.
  // Generous explicit timeout: on a saturated box the one-time load has been
  // measured above the 20s default that used to fail the first test instead.
  beforeAll(async () => {
    await import('../config')
    await import('../db')
  }, 120_000)

  beforeEach(async () => {
    mockCreateDb.mockClear()
    vi.resetModules()
    // Reset globalThis.__db
    delete (globalThis as Record<string, unknown>).__db
    // Reset environment
    process.env = { ...originalEnv }
    // Reset config cache
    const { resetConfig } = await import('../config')
    resetConfig()
  })

  afterEach(() => {
    process.env = originalEnv
    delete (globalThis as Record<string, unknown>).__db
  })

  describe('Self-hosted mode', () => {
    it('should create singleton database from DATABASE_URL', async () => {
      setupMinimalConfig()

      const { db } = await import('../db')

      // Access db to trigger initialization
      const query = db.query

      expect(mockCreateDb).toHaveBeenCalledTimes(1)
      expect(mockCreateDb).toHaveBeenCalledWith('postgres://localhost/quackback', { max: 50 })
      expect(query).toBeDefined()
    })

    it('should reuse singleton on subsequent accesses', async () => {
      setupMinimalConfig()

      const { db } = await import('../db')

      // Access multiple times - void to satisfy linter
      void db.query
      void db.query
      void db.query

      expect(mockCreateDb).toHaveBeenCalledTimes(1)
    })

    it('should throw error when DATABASE_URL not set', async () => {
      // Set up config without DATABASE_URL
      process.env.BASE_URL = 'http://localhost:3000'
      process.env.SECRET_KEY = 'test-secret-key-that-is-at-least-32-characters-long'
      process.env.REDIS_URL = 'redis://localhost:6379'
      delete (process.env as Record<string, string | undefined>).DATABASE_URL

      const { db } = await import('../db')

      expect(() => db.query).toThrow('Configuration validation failed')
    })
  })

  describe('db proxy behavior', () => {
    it('should lazily access database on property access', async () => {
      setupMinimalConfig()

      const { db } = await import('../db')

      // Just importing should not create db
      expect(mockCreateDb).not.toHaveBeenCalled()

      // Accessing a property should trigger creation
      void db.query
      expect(mockCreateDb).toHaveBeenCalledTimes(1)
    })
  })
})
