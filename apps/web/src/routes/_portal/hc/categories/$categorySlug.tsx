import { createFileRoute, notFound, Outlet } from '@tanstack/react-router'
import {
  getPublicCategoryBySlugFn,
  listPublicArticlesForCategoryFn,
  listPublicCategoriesFn,
} from '@/lib/server/functions/help-center'
import { getSubcategories } from '@/components/help-center/help-center-utils'
import { portalGateHead } from '@/lib/shared/route-head'

export const Route = createFileRoute('/_portal/hc/categories/$categorySlug')({
  loader: async ({ params }) => {
    let category: Awaited<ReturnType<typeof getPublicCategoryBySlugFn>>
    try {
      category = await getPublicCategoryBySlugFn({ data: { slug: params.categorySlug } })
    } catch {
      throw notFound()
    }

    const [articles, allCategories] = await Promise.all([
      listPublicArticlesForCategoryFn({ data: { categoryId: category.id } }),
      listPublicCategoriesFn({ data: {} }),
    ])

    const subcategories = getSubcategories(allCategories, category.id)

    const subcategoryArticles = await Promise.all(
      subcategories.map(async (sub) => ({
        ...sub,
        articles: await listPublicArticlesForCategoryFn({ data: { categoryId: sub.id } }),
      }))
    )

    return { category, articles, subcategories: subcategoryArticles, allCategories }
  },
  head: ({ loaderData, matches }) => {
    // Behind the sign-in gate the page shows only the gate, so it takes the
    // gate's title and indexing instead of describing this page (DEF-44).
    const gated = portalGateHead(matches)
    if (gated) return gated
    if (!loaderData) return {}
    const { category } = loaderData
    return {
      meta: [{ title: `${category.name} - Help Center` }],
    }
  },
  component: () => <Outlet />,
})
