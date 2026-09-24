/**
 * Server Functions for Help Center Operations
 */

import { createServerFn, createServerOnlyFn } from '@tanstack/react-start'
import type { HelpCenterCategoryId, HelpCenterArticleId, PrincipalId } from '@quackback/ids'
import { sanitizeTiptapContent } from '@/lib/server/sanitize-tiptap'
import { requireAuth, getOptionalAuth } from './auth-helpers'
import {
  listCategories,
  listPublicCategories,
  listPublicCategoryEditors,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  restoreCategory,
  listArticles,
  listPublicArticles,
  listPublicArticlesForCategory,
  getArticleById,
  getPublicArticleBySlug,
  createArticle,
  updateArticle,
  publishArticle,
  unpublishArticle,
  deleteArticle,
  restoreArticle,
  recordArticleFeedback,
} from '@/lib/server/domains/help-center/help-center.service'
import { filterText } from '@/lib/shared/schemas/list-filters'
import {
  listCategoriesSchema,
  getCategorySchema,
  deleteCategorySchema,
  createCategorySchema,
  updateCategorySchema,
  createArticleSchema,
  updateArticleSchema,
  getArticleSchema,
  deleteArticleSchema,
  listArticlesSchema,
  listPublicArticlesSchema,
  publishArticleSchema,
  unpublishArticleSchema,
  articleFeedbackSchema,
  getCategoryBySlugSchema,
  getArticleBySlugSchema,
  restoreCategorySchema,
  restoreArticleSchema,
} from '@/lib/shared/schemas/help-center'
import { z } from 'zod'
import { toIsoString, toIsoStringOrNull } from '@/lib/shared/utils'
import { NotFoundError } from '@/lib/shared/errors'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'help-center' })

// ============================================================================
// Public read gate
// ============================================================================

/**
 * Public help-center content is portal content. It is served only when the
 * help center is switched on (the `helpCenter` feature flag AND
 * helpCenterConfig.enabled, the same pair the /hc route checks) AND the caller
 * passes the portal-access gate every other portal read uses
 * (resolvePortalAccessForRequest). Any failure to decide denies. Server-only:
 * also used by the /api/widget/kb-search server route.
 */
export const isPublicHelpCenterReadable = createServerOnlyFn(async (): Promise<boolean> => {
  try {
    const { getTenantSettings } = await import('@/lib/server/domains/settings/settings.service')
    const tenant = await getTenantSettings()
    if (!tenant?.featureFlags?.helpCenter || !tenant.helpCenterConfig?.enabled) return false
    const { resolvePortalAccessForRequest } = await import('./portal-access')
    const access = await resolvePortalAccessForRequest()
    return access.granted
  } catch (error) {
    log.error({ err: error }, 'help center read gate failed; denying')
    return false
  }
})

/** Throw the same not-found shape the slug lookups use when the gate denies. */
async function assertPublicHelpCenterReadable(): Promise<void> {
  if (!(await isPublicHelpCenterReadable())) {
    throw new NotFoundError('HELP_CENTER_NOT_FOUND', 'Help center not found')
  }
}

// ============================================================================
// Helper: serialize article dates
// ============================================================================

function serializeArticle<
  T extends { createdAt: Date; updatedAt: Date; publishedAt: Date | null; deletedAt?: Date | null },
>(article: T) {
  return {
    ...article,
    createdAt: toIsoString(article.createdAt),
    updatedAt: toIsoString(article.updatedAt),
    publishedAt: toIsoStringOrNull(article.publishedAt),
    deletedAt: toIsoStringOrNull(article.deletedAt ?? null),
  }
}

function serializeCategory<T extends { createdAt: Date; updatedAt: Date; deletedAt?: Date | null }>(
  cat: T
) {
  return {
    ...cat,
    createdAt: toIsoString(cat.createdAt),
    updatedAt: toIsoString(cat.updatedAt),
    deletedAt: 'deletedAt' in cat ? toIsoStringOrNull(cat.deletedAt ?? null) : undefined,
  }
}

// ============================================================================
// Category Server Functions
// ============================================================================

export const listCategoriesFn = createServerFn({ method: 'GET' })
  .validator(listCategoriesSchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin', 'member'] })
    const categories = await listCategories({ showDeleted: data.showDeleted })
    return categories.map(serializeCategory)
  })

export const listPublicCategoriesFn = createServerFn({ method: 'GET' })
  .validator(z.object({}))
  .handler(async () => {
    if (!(await isPublicHelpCenterReadable())) return []
    const categories = await listPublicCategories()
    return categories.map(serializeCategory)
  })

export const getCategoryFn = createServerFn({ method: 'GET' })
  .validator(getCategorySchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin', 'member'] })
    const category = await getCategoryById(data.id as HelpCenterCategoryId)
    return serializeCategory(category)
  })

export const getPublicCategoryBySlugFn = createServerFn({ method: 'GET' })
  .validator(getCategoryBySlugSchema)
  .handler(async ({ data }) => {
    await assertPublicHelpCenterReadable()
    // Use the public variant so categories an admin marked private aren't
    // reachable by direct-slug lookup. The route serves unauthenticated
    // help-center traffic.
    const { getPublicCategoryBySlug } =
      await import('@/lib/server/domains/help-center/help-center.category.service')
    const category = await getPublicCategoryBySlug(data.slug)
    return serializeCategory(category)
  })

export const createCategoryFn = createServerFn({ method: 'POST' })
  .validator(createCategorySchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin'] })
    const category = await createCategory(data)
    return serializeCategory(category)
  })

export const updateCategoryFn = createServerFn({ method: 'POST' })
  .validator(updateCategorySchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin'] })
    const category = await updateCategory(data.id as HelpCenterCategoryId, data)
    return serializeCategory(category)
  })

export const deleteCategoryFn = createServerFn({ method: 'POST' })
  .validator(deleteCategorySchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin'] })
    await deleteCategory(data.id as HelpCenterCategoryId)
    return { success: true }
  })

// ============================================================================
// Article Server Functions
// ============================================================================

export const listArticlesFn = createServerFn({ method: 'GET' })
  .validator(listArticlesSchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin', 'member'] })
    const result = await listArticles(data)
    return {
      ...result,
      items: result.items.map(serializeArticle),
    }
  })

export const restoreCategoryFn = createServerFn({ method: 'POST' })
  .validator(restoreCategorySchema)
  .handler(async ({ data }) => {
    log.debug({ category_id: data.id }, 'restore category')
    try {
      await requireAuth({ roles: ['admin', 'member'] })
      const category = await restoreCategory(data.id as HelpCenterCategoryId)
      log.info({ category_id: category.id }, 'category restored')
      return serializeCategory(category)
    } catch (error) {
      log.error({ err: error }, 'restore category failed')
      throw error
    }
  })

export const restoreArticleFn = createServerFn({ method: 'POST' })
  .validator(restoreArticleSchema)
  .handler(async ({ data }) => {
    log.debug({ article_id: data.id }, 'restore article')
    try {
      await requireAuth({ roles: ['admin', 'member'] })
      const article = await restoreArticle(data.id as HelpCenterArticleId)
      log.info({ article_id: article.id }, 'article restored')
      return serializeArticle(article)
    } catch (error) {
      log.error({ err: error }, 'restore article failed')
      throw error
    }
  })

export const listPublicArticlesFn = createServerFn({ method: 'GET' })
  .validator(listPublicArticlesSchema)
  .handler(async ({ data }) => {
    if (!(await isPublicHelpCenterReadable())) {
      return { items: [], nextCursor: null, hasMore: false }
    }
    const result = await listPublicArticles(data)
    return {
      ...result,
      items: result.items.map(serializeArticle),
    }
  })

export const listPublicArticlesForCategoryFn = createServerFn({ method: 'GET' })
  .validator(z.object({ categoryId: z.string() }))
  .handler(async ({ data }) => {
    if (!(await isPublicHelpCenterReadable())) return []
    const articles = await listPublicArticlesForCategory(data.categoryId)
    return articles.map((a) => ({
      ...a,
      publishedAt: toIsoStringOrNull(a.publishedAt),
    }))
  })

export const listPublicCategoryEditorsFn = createServerFn({ method: 'GET' })
  .validator(z.object({}))
  .handler(async () => {
    if (!(await isPublicHelpCenterReadable())) return {}
    return listPublicCategoryEditors()
  })

export const getArticleFn = createServerFn({ method: 'GET' })
  .validator(getArticleSchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin', 'member'] })
    const article = await getArticleById(data.id as HelpCenterArticleId)
    return serializeArticle(article)
  })

export const getPublicArticleBySlugFn = createServerFn({ method: 'GET' })
  .validator(getArticleBySlugSchema)
  .handler(async ({ data }) => {
    await assertPublicHelpCenterReadable()
    const article = await getPublicArticleBySlug(data.slug)
    const { helpfulCount: _h, notHelpfulCount: _n, ...publicArticle } = serializeArticle(article)
    return publicArticle
  })

export const createArticleFn = createServerFn({ method: 'POST' })
  .validator(createArticleSchema)
  .handler(async ({ data }) => {
    const auth = await requireAuth({ roles: ['admin', 'member'] })
    const article = await createArticle(
      {
        ...data,
        contentJson: data.contentJson ? sanitizeTiptapContent(data.contentJson) : null,
      },
      auth.principal.id as PrincipalId
    )
    return serializeArticle(article)
  })

export const updateArticleFn = createServerFn({ method: 'POST' })
  .validator(updateArticleSchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin', 'member'] })
    const article = await updateArticle(data.id as HelpCenterArticleId, {
      ...data,
      contentJson: data.contentJson ? sanitizeTiptapContent(data.contentJson) : data.contentJson,
    })
    return serializeArticle(article)
  })

export const publishArticleFn = createServerFn({ method: 'POST' })
  .validator(publishArticleSchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin', 'member'] })
    const article = await publishArticle(data.id as HelpCenterArticleId)
    return serializeArticle(article)
  })

export const unpublishArticleFn = createServerFn({ method: 'POST' })
  .validator(unpublishArticleSchema)
  .handler(async ({ data }) => {
    await requireAuth({ roles: ['admin', 'member'] })
    const article = await unpublishArticle(data.id as HelpCenterArticleId)
    return serializeArticle(article)
  })

export const deleteArticleFn = createServerFn({ method: 'POST' })
  .validator(deleteArticleSchema)
  .handler(async ({ data }) => {
    // Soft delete (deleteArticle sets deletedAt) — team OK.
    await requireAuth({ roles: ['admin', 'member'] })
    await deleteArticle(data.id as HelpCenterArticleId)
    return { success: true }
  })

export const recordArticleFeedbackFn = createServerFn({ method: 'POST' })
  .validator(articleFeedbackSchema)
  .handler(async ({ data }) => {
    // Feedback is a write on portal content: same gate as the reads.
    await assertPublicHelpCenterReadable()
    const auth = await getOptionalAuth()
    await recordArticleFeedback(
      data.articleId as HelpCenterArticleId,
      data.helpful,
      (auth?.principal?.id as PrincipalId) ?? null
    )
    return { success: true }
  })

// ============================================================================
// Public Hybrid Search
// ============================================================================

export const searchPublicArticlesFn = createServerFn({ method: 'GET' })
  .validator(
    // The query feeds a full-text search, and Postgres rejects a NUL in text
    // (DEF-45; /api/widget/kb-search holds its ?q= to the same rule).
    z.object({ query: filterText().min(1), limit: z.number().int().min(1).max(20).optional() })
  )
  .handler(async ({ data }) => {
    if (!(await isPublicHelpCenterReadable())) return []
    const { hybridSearch } =
      await import('@/lib/server/domains/help-center/help-center-search.service')
    return hybridSearch(data.query, data.limit ?? 10)
  })
