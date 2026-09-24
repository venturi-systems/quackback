// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * The create-category dialog also opens from inside the create-article form
 * (its sidebar's "Create new category" button). React bubbles a portal's
 * events through the component tree, so submitting the category form used to
 * submit the article form around it as well.
 */

const createCategory = vi.fn(async (_input: { name: string }) => ({ id: 'category_created' }))

vi.mock('@/lib/client/mutations/help-center', () => ({
  useCreateCategory: () => ({ mutateAsync: createCategory, isPending: false }),
  useUpdateCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => ({ data: [] }) }
})

vi.mock('@/lib/client/queries/help-center', () => ({
  helpCenterQueries: { categories: () => ({ queryKey: ['help-center', 'categories'] }) },
}))

import { CategoryFormDialog } from '../category-form-dialog'

describe('CategoryFormDialog inside another form', () => {
  it('creates the category without submitting the form around it', async () => {
    const outerSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault())
    const onCreated = vi.fn()
    render(
      <form onSubmit={outerSubmit}>
        <CategoryFormDialog open onOpenChange={() => {}} onCreated={onCreated} />
      </form>
    )

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Billing' } })
    const categoryForm = screen.getByRole('dialog').querySelector('form')
    expect(categoryForm).not.toBeNull()
    fireEvent.submit(categoryForm as HTMLFormElement)

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('category_created'))
    expect(createCategory).toHaveBeenCalledWith(expect.objectContaining({ name: 'Billing' }))
    expect(outerSubmit).not.toHaveBeenCalled()
  })
})
