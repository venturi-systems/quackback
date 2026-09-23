import { describe, it, expect, vi } from 'vitest'
import { KeyboardCode } from '@dnd-kit/core'
import { roadmapColumnKeyboardCoordinates } from '../roadmap-keyboard'

type Rect = { left: number; top: number; width: number; height: number }

function context(overId: string | null, originId = 'status_b') {
  const rects = new Map<string, Rect>([
    ['status_c', { left: 640, top: 100, width: 300, height: 600 }],
    ['status_a', { left: 0, top: 100, width: 300, height: 600 }],
    ['status_b', { left: 320, top: 100, width: 300, height: 600 }],
  ])
  const containers = [...rects.keys()].map((id) => ({ id, data: { current: { type: 'Column' } } }))
  return {
    active: { id: 'post_1', data: { current: { type: 'Task', statusId: originId } } },
    collisionRect: { left: 330, top: 160, width: 280, height: 90 },
    droppableRects: rects,
    droppableContainers: { getEnabled: () => containers },
    over: overId ? { id: overId } : null,
  }
}

function press(code: string, ctx: ReturnType<typeof context>) {
  const event = { code, preventDefault: vi.fn() } as unknown as KeyboardEvent
  const result = roadmapColumnKeyboardCoordinates(event, {
    active: 'post_1',
    currentCoordinates: { x: 330, y: 160 },
    context: ctx as never,
  })
  return { result, event: event as unknown as { preventDefault: ReturnType<typeof vi.fn> } }
}

describe('roadmapColumnKeyboardCoordinates', () => {
  it('jumps to the next column to the right', () => {
    const { result, event } = press(KeyboardCode.Right, context('status_b'))
    expect(result).toEqual({ x: 652, y: 148 })
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('jumps to the previous column to the left', () => {
    expect(press(KeyboardCode.Left, context('status_b')).result).toEqual({ x: 12, y: 148 })
  })

  it('treats Down and Up like Right and Left', () => {
    expect(press(KeyboardCode.Down, context('status_a')).result).toEqual({ x: 332, y: 148 })
    expect(press(KeyboardCode.Up, context('status_c')).result).toEqual({ x: 332, y: 148 })
  })

  it('stays on the last column instead of wrapping', () => {
    expect(press(KeyboardCode.Right, context('status_c')).result).toEqual({ x: 652, y: 148 })
  })

  it('starts from the origin column before the card is over any column', () => {
    expect(press(KeyboardCode.Right, context(null, 'status_a')).result).toEqual({
      x: 332,
      y: 148,
    })
  })

  it('leaves Space, Enter and Escape to dnd-kit', () => {
    for (const code of [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Esc]) {
      const { result, event } = press(code, context('status_b'))
      expect(result).toBeUndefined()
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
  })
})
