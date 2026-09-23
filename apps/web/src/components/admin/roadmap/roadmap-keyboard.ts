import { KeyboardCode, type KeyboardCoordinateGetter } from '@dnd-kit/core'

const FORWARD = new Set<string>([KeyboardCode.Right, KeyboardCode.Down])
const BACKWARD = new Set<string>([KeyboardCode.Left, KeyboardCode.Up])

/**
 * Keyboard coordinates for the admin roadmap board.
 *
 * dnd-kit's default getter nudges a dragged card 25px per key press, which
 * takes a dozen presses to cross one status column. Status columns are the
 * only drop targets here, so each arrow key jumps to the next or previous
 * column (in left-to-right order) and the drop lands on that column.
 * Returns undefined for any other key so dnd-kit keeps its defaults
 * (Space/Enter drop, Escape cancel).
 */
export const roadmapColumnKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context: { active, collisionRect, droppableRects, droppableContainers, over } }
) => {
  const forward = FORWARD.has(event.code)
  if (!forward && !BACKWARD.has(event.code)) return undefined
  if (!active || !collisionRect) return undefined

  const columns = droppableContainers
    .getEnabled()
    .filter((container) => container.data.current?.type === 'Column')
    .flatMap((container) => {
      const rect = droppableRects.get(container.id)
      return rect ? [{ id: container.id, rect }] : []
    })
    .sort((a, b) => a.rect.left - b.rect.left)
  if (columns.length === 0) return undefined

  event.preventDefault()

  // Start from the column the card is over, or the one it was picked up from.
  const originId = active.data.current?.statusId
  let index = columns.findIndex((column) => column.id === (over?.id ?? originId))
  if (index < 0) index = 0

  const next = Math.min(columns.length - 1, Math.max(0, index + (forward ? 1 : -1)))
  const target = columns[next].rect
  // Place the card's top-left just inside the target column so the
  // rectangle-intersection collision check resolves to that column.
  return { x: target.left + 12, y: target.top + 48 }
}
