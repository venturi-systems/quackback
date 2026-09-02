/**
 * Advanced API Integration Tests (boundary conditions and proxy voting)
 *
 * These tests run against a live server and require:
 * 1. Dev server running: `bun run dev`
 * 2. Valid API key in database
 *
 * Run with: API_KEY=qb_xxx bun run test apps/web/src/lib/api/__tests__/api-integration-advanced.test.ts
 *
 * To skip these tests (CI without server): SKIP_INTEGRATION=true bun run test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  SKIP_INTEGRATION,
  API_KEY,
  api,
  createTestState,
  setUpIntegrationSuite,
  requireBoardId,
  requirePostId,
  cleanupCreatedResources,
} from './api-integration.helpers'

const state = createTestState()

describe.skipIf(SKIP_INTEGRATION || !API_KEY)('API Integration Tests - Advanced', () => {
  // Throws on an unreachable server, a rejected key, or a fixture it could not
  // establish. There is deliberately no `serverAvailable` flag to consult: a
  // per-test `if (...) return` reports an unrun case as a passing one.
  beforeAll(async () => {
    await setUpIntegrationSuite(state)
  })

  afterAll(async () => {
    await cleanupCreatedResources(state.createdIds)
  })

  describe('Boundary Conditions', () => {
    it('accepts max length title (200 chars)', async () => {
      const { status, data } = await api('POST', '/posts', {
        boardId: requireBoardId(state),
        title: 'A'.repeat(200),
        content: 'Test content',
      })
      expect(status).toBe(201)
      state.createdIds.posts.push((data as { data: { id: string } }).data.id)
    })

    it('rejects title exceeding max length', async () => {
      const { status } = await api('POST', '/posts', {
        boardId: requireBoardId(state),
        title: 'A'.repeat(201),
        content: 'Test content',
      })
      expect(status).toBe(400)
    })

    it('handles unicode in post title', async () => {
      const { status, data } = await api('POST', '/posts', {
        boardId: requireBoardId(state),
        title: '🎉 Unicode Test 日本語 Ñoño',
        content: 'Testing unicode support',
      })
      expect(status).toBe(201)
      state.createdIds.posts.push((data as { data: { id: string } }).data.id)
    })
  })

  describe('Proxy Voting', () => {
    let voterPrincipalId: string

    // The voter is a prerequisite of five cases below, so it is established
    // once here and fails the whole group loudly when it cannot be. It used to
    // be created inside the first case behind `if (!voterPrincipalId) return`,
    // which turned "identify did not return a principal" into four green tests.
    beforeAll(async () => {
      const stamp = Date.now()
      const { status, data } = await api('POST', '/users/identify', {
        externalId: `proxy-vote-test-${stamp}`,
        name: 'Proxy Vote Test User',
        email: `proxy-test-${stamp}@example.com`,
      })
      if (status !== 200 && status !== 201) {
        throw new Error(`Proxy-voting setup failed: POST /users/identify returned ${status}.`)
      }
      const id = (data as { data?: { principalId?: string } } | null)?.data?.principalId
      if (!id) {
        throw new Error('Proxy-voting setup failed: POST /users/identify returned no principalId.')
      }
      voterPrincipalId = id
    })

    it('POST /posts/:postId/vote/proxy requires voterPrincipalId', async () => {
      const { status } = await api('POST', `/posts/${requirePostId(state)}/vote/proxy`, {})
      expect(status).toBe(400)
    })

    it('POST /posts/:postId/vote/proxy rejects invalid post ID', async () => {
      const { status } = await api('POST', '/posts/invalid_id/vote/proxy', {
        voterPrincipalId: 'principal_01h455vb4pex5vsknk084sn02q',
      })
      expect(status).toBe(400)
    })

    it('POST /posts/:postId/vote/proxy adds a proxy vote', async () => {
      const { status, data } = await api('POST', `/posts/${requirePostId(state)}/vote/proxy`, {
        voterPrincipalId,
      })
      expect(status).toBe(200)
      const result = (data as { data: { voted: boolean; voteCount: number } }).data
      expect(result).toHaveProperty('voted')
      expect(result).toHaveProperty('voteCount')
      expect(typeof result.voteCount).toBe('number')
    })

    it('POST /posts/:postId/vote/proxy is idempotent', async () => {
      const { status, data } = await api('POST', `/posts/${requirePostId(state)}/vote/proxy`, {
        voterPrincipalId,
      })
      expect(status).toBe(200)
      const result = (data as { data: { voted: boolean } }).data
      expect(result.voted).toBe(false) // Already voted, no-op
    })

    it('DELETE /posts/:postId/vote/proxy removes the proxy vote', async () => {
      const { status } = await api('DELETE', `/posts/${requirePostId(state)}/vote/proxy`, {
        voterPrincipalId,
      })
      expect(status).toBe(204)
    })

    it('DELETE /posts/:postId/vote/proxy is safe when no vote exists', async () => {
      // Deleting again after already removed
      const { status } = await api('DELETE', `/posts/${requirePostId(state)}/vote/proxy`, {
        voterPrincipalId,
      })
      expect(status).toBe(204)
    })

    it('DELETE /posts/:postId/vote/proxy requires voterPrincipalId', async () => {
      const { status } = await api('DELETE', `/posts/${requirePostId(state)}/vote/proxy`, {})
      expect(status).toBe(400)
    })
  })
})
