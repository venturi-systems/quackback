// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

/**
 * A category created from the create-article sidebar used to be selected the
 * moment the create call returned. The Select sits inside the article form,
 * so Radix mirrors its value into a hidden native <select>; until the list
 * refetch added an <option> for the new id, that select read the value back
 * as '' and reported it as a change, which cleared the selection. The sidebar
 * now selects a created category only once the category list holds it.
 */

type Category = { id: string; name: string; icon: string | null }
let mockCategories: Category[] | undefined

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => ({ data: mockCategories }) }
})

vi.mock('@/lib/client/queries/help-center', () => ({
  helpCenterQueries: { categories: () => ({ queryKey: ['help-center', 'categories'] }) },
}))

// Stands in for the create-category dialog: it reports a created category the
// way the real dialog does, through onCreated, without a server.
vi.mock('../category-form-dialog', () => ({
  CategoryFormDialog: ({ onCreated }: { onCreated?: (id: string) => void }) => (
    <button type="button" onClick={() => onCreated?.('category_new')}>
      report created category
    </button>
  ),
}))

// These tests cover when the sidebar selects, not how Radix renders a Select.
vi.mock('@/components/ui/select', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    Select: Pass,
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: Pass,
    SelectItem: Pass,
  }
})

import { HelpCenterMetadataSidebarContent } from '../help-center-metadata-sidebar'

const EXISTING: Category = { id: 'category_existing', name: 'Guides', icon: null }
const CREATED: Category = { id: 'category_new', name: 'Billing', icon: null }

function renderSidebar(onCategoryChange: (categoryId: string) => void) {
  const props = {
    categoryId: '',
    onCategoryChange,
    isPublished: false,
    onPublishToggle: () => {},
  }
  const view = render(<HelpCenterMetadataSidebarContent {...props} />)
  return { rerender: () => view.rerender(<HelpCenterMetadataSidebarContent {...props} />) }
}

beforeEach(() => {
  mockCategories = [EXISTING]
})

describe('HelpCenterMetadataSidebar: a category created from the sidebar', () => {
  it('is selected only once the category list holds it', () => {
    const onCategoryChange = vi.fn()
    const { rerender } = renderSidebar(onCategoryChange)

    fireEvent.click(screen.getByRole('button', { name: 'report created category' }))
    expect(onCategoryChange).not.toHaveBeenCalled()

    mockCategories = [EXISTING, CREATED]
    rerender()
    expect(onCategoryChange).toHaveBeenCalledTimes(1)
    expect(onCategoryChange).toHaveBeenCalledWith('category_new')

    // A later refetch does not select it a second time.
    mockCategories = [EXISTING, CREATED]
    rerender()
    expect(onCategoryChange).toHaveBeenCalledTimes(1)
  })

  it('is selected at once when the list already holds it', () => {
    mockCategories = [EXISTING, CREATED]
    const onCategoryChange = vi.fn()
    renderSidebar(onCategoryChange)

    fireEvent.click(screen.getByRole('button', { name: 'report created category' }))
    expect(onCategoryChange).toHaveBeenCalledTimes(1)
    expect(onCategoryChange).toHaveBeenCalledWith('category_new')
  })
})
