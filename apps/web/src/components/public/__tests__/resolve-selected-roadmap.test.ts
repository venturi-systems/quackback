import { describe, expect, it } from 'vitest'
import { resolveSelectedRoadmapId } from '../resolve-selected-roadmap'

const roadmaps = [{ id: 'roadmap_first' }, { id: 'roadmap_second' }]

describe('resolveSelectedRoadmapId', () => {
  it('shows the requested roadmap when the viewer can see it', () => {
    expect(resolveSelectedRoadmapId('roadmap_second', roadmaps)).toBe('roadmap_second')
  })

  it('falls back to the first roadmap for an id the viewer cannot see', () => {
    // Deleted, private or mistyped: the server rejects it, so every status
    // column would fail if the board rendered it.
    expect(resolveSelectedRoadmapId('roadmap_gone', roadmaps)).toBe('roadmap_first')
  })

  it('falls back to the first roadmap when none is requested', () => {
    expect(resolveSelectedRoadmapId(null, roadmaps)).toBe('roadmap_first')
    expect(resolveSelectedRoadmapId(undefined, roadmaps)).toBe('roadmap_first')
  })

  it('selects nothing when there is no roadmap', () => {
    expect(resolveSelectedRoadmapId('roadmap_first', [])).toBeNull()
    expect(resolveSelectedRoadmapId(null, [])).toBeNull()
  })
})
