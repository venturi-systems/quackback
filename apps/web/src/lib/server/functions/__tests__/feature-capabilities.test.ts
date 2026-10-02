import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateId } from '@quackback/ids'
const h = vi.hoisted(() => ({
  access: vi.fn(),
  auth: vi.fn(),
  actor: vi.fn(),
  board: vi.fn(),
  options: vi.fn(),
  handlers: [] as Array<(args: { data: { boardId: string } }) => Promise<unknown>>,
}))
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = {
      validator: () => chain,
      handler: (fn: (typeof h.handlers)[number]) => {
        h.handlers.push(fn)
        return chain
      },
    }
    return chain
  },
}))
vi.mock('../portal-access', () => ({ resolvePortalAccessForRequest: h.access }))
vi.mock('../auth-helpers', () => ({ getOptionalAuth: h.auth, policyActorFromAuth: h.actor }))
vi.mock('@/lib/server/domains/boards/board.public', () => ({ getPublicBoardById: h.board }))
vi.mock('@/lib/server/feature-pipeline/semantic-tags', () => ({ semanticOptions: h.options }))
await import('../feature-capabilities')
const boardId = generateId('board')
beforeEach(() => {
  vi.clearAllMocks()
  h.access.mockResolvedValue({ granted: true })
  h.auth.mockResolvedValue(null)
  h.actor.mockResolvedValue({ role: 'user', principalType: 'anonymous' })
  h.board.mockResolvedValue({ id: boardId })
  h.options.mockResolvedValue({
    required: true,
    options: [{ id: generateId('tag'), label: 'Usage data imports' }],
  })
})
describe('capability choices honor portal and board visibility', () => {
  it('lets a sessionless visitor read choices on an accessible public board', async () => {
    expect(await h.handlers[0]({ data: { boardId } })).toMatchObject({ required: true })
    expect(h.actor).toHaveBeenCalledWith(null)
    expect(h.options).toHaveBeenCalledWith(boardId, false)
  })
  it('does not bypass the authenticated portal read gate', async () => {
    h.access.mockResolvedValue({ granted: false })
    await expect(h.handlers[0]({ data: { boardId } })).rejects.toThrow('Portal access required')
    expect(h.options).not.toHaveBeenCalled()
  })
  it('does not reveal capabilities for an invisible board', async () => {
    h.board.mockResolvedValue(null)
    await expect(h.handlers[0]({ data: { boardId } })).rejects.toThrow('Board not found')
    expect(h.options).not.toHaveBeenCalled()
  })
})
