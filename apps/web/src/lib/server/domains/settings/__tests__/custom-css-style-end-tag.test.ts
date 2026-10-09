/**
 * updateCustomCss refuses a stylesheet containing `</style`.
 *
 * Custom CSS is served as the text of a <style> element on the public portal,
 * its sign-in gate, the auth pages and the widget. The HTML parser ends that
 * element at the first `</style`, in any letter case, so the rest of a stored
 * value would be parsed as markup. Rendering neutralises the sequence for rows
 * already stored (cssForStyleElement); a new value carrying it is refused
 * before anything is written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ValidationError } from '@/lib/shared/errors'

const hoisted = vi.hoisted(() => {
  const mockWhere = vi.fn()
  const mockSet = vi.fn(() => ({ where: mockWhere }))
  return {
    mockWhere,
    mockSet,
    mockDbUpdate: vi.fn(() => ({ set: mockSet })),
    mockRequireSettings: vi.fn(),
    mockInvalidateSettingsCache: vi.fn(),
    mockAssertTierFeature: vi.fn(),
  }
})

vi.mock('@/lib/server/db', () => ({
  db: { update: hoisted.mockDbUpdate },
  settings: { id: 'id' },
  eq: vi.fn(),
}))

vi.mock('@/lib/server/storage/s3', () => ({ deleteObject: vi.fn() }))

vi.mock('@/lib/server/config-file/managed-guard', () => ({
  assertNotManaged: vi.fn(async () => {}),
}))

vi.mock('../tier-enforce', () => ({ assertTierFeature: hoisted.mockAssertTierFeature }))

vi.mock('../settings.helpers', () => ({
  requireSettings: hoisted.mockRequireSettings,
  invalidateSettingsCache: hoisted.mockInvalidateSettingsCache,
  wrapDbError: (_operation: string, error: unknown) => {
    throw error
  },
  parseJsonOrNull: vi.fn(),
  withoutUnsafeKeys: <T>(value: T) => value,
}))

import { updateCustomCss } from '../settings.media'

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.mockRequireSettings.mockResolvedValue({ id: 'org_1' })
  hoisted.mockAssertTierFeature.mockResolvedValue(undefined)
})

describe('updateCustomCss and </style', () => {
  it.each([
    '.a { color: red }</style><script>alert(1)</script>',
    '.a { color: red }</STYLE >',
    '.a::before { content: "</StYlE/>" }',
  ])('refuses %j and writes nothing', async (css) => {
    const result = updateCustomCss(css)
    await expect(result).rejects.toBeInstanceOf(ValidationError)
    await expect(result).rejects.toMatchObject({ code: 'INVALID_CUSTOM_CSS' })
    expect(hoisted.mockDbUpdate).not.toHaveBeenCalled()
    expect(hoisted.mockInvalidateSettingsCache).not.toHaveBeenCalled()
  })

  it('stores CSS whose only < is a range comparison', async () => {
    const css = '@media (width < 600px) { .a { color: red } }'
    await expect(updateCustomCss(css)).resolves.toBe(css)
    expect(hoisted.mockSet).toHaveBeenCalledWith({ customCss: css })
    expect(hoisted.mockInvalidateSettingsCache).toHaveBeenCalledOnce()
  })

  it('still lets an empty value clear the stylesheet', async () => {
    await expect(updateCustomCss('')).resolves.toBe('')
    expect(hoisted.mockSet).toHaveBeenCalledWith({ customCss: '' })
    expect(hoisted.mockAssertTierFeature).not.toHaveBeenCalled()
  })
})
