// @vitest-environment happy-dom
/**
 * <HelpCenterHeroSearch> is the article search on the public help-center
 * landing page. It must search through the portal's server function. The
 * widget's /api/widget/kb-search route answers 404 whenever the widget is
 * disabled, which is the db:seed default, so a hero search built on it shows
 * portal visitors nothing (venturi-systems/feedback#472).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const hoisted = vi.hoisted(() => ({ search: vi.fn() }))

vi.mock('@/lib/server/functions/help-center', () => ({
  searchPublicArticlesFn: (args: unknown) => hoisted.search(args),
}))

const { HelpCenterHeroSearch } = await import('../help-center-search')

/** One row as searchPublicArticlesFn returns it (HybridSearchResult). */
const billingArticle = {
  id: 'kb_article_billing',
  slug: 'update-your-billing-details',
  title: 'Update your billing details',
  description: null,
  content: 'Billing details appear on every invoice.',
  categoryId: 'kb_category_billing',
  categorySlug: 'account-and-billing',
  categoryName: 'Account and Billing',
  score: 0.5,
}

/** What /api/widget/kb-search answers while the widget is disabled. */
const widgetDisabled = () =>
  new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
    status: 404,
  })

beforeEach(() => {
  hoisted.search.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => widgetDisabled())
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function type(value: string) {
  fireEvent.change(screen.getByPlaceholderText('Search articles...'), { target: { value } })
}

describe('HelpCenterHeroSearch', () => {
  it('searches through searchPublicArticlesFn and never calls the widget route', async () => {
    hoisted.search.mockResolvedValue([billingArticle])
    render(<HelpCenterHeroSearch />)

    type('  billing ')

    // The component waits out its 300 ms debounce before it searches.
    await waitFor(() =>
      expect(hoisted.search).toHaveBeenCalledWith({ data: { query: 'billing', limit: 8 } })
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lists a result with its title and category name', async () => {
    hoisted.search.mockResolvedValue([billingArticle])
    render(<HelpCenterHeroSearch />)

    type('billing')

    const result = await screen.findByRole('button', { name: /Update your billing details/ })
    expect(result).toHaveTextContent('Account and Billing')
  })
})
