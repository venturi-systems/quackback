import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  bigint,
  uuid,
  index,
  unique,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { typeIdColumn } from '@quackback/ids/drizzle'
import { boards, tags } from './boards'
import { posts } from './posts'

export const featurePipelineBoards = pgTable('feature_pipeline_boards', {
  boardId: typeIdColumn('board')('board_id')
    .primaryKey()
    .references(() => boards.id, { onDelete: 'restrict' }),
  enabled: boolean('enabled').notNull().default(false),
})
export const featurePipelineCapabilities = pgTable(
  'feature_pipeline_capabilities',
  {
    id: text('id').primaryKey(),
    tagId: typeIdColumn('tag')('tag_id')
      .notNull()
      .unique()
      .references(() => tags.id, { onDelete: 'restrict' }),
    visibility: text('visibility').notNull(),
    taxonomyVersion: text('taxonomy_version').notNull(),
    repository: text('repository').notNull(),
    repositoryId: text('repository_id').notNull(),
    sourceRepository: text('source_repository').notNull(),
    sourceRepositoryId: text('source_repository_id').notNull(),
    routePolicy: text('route_policy').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    check(
      'feature_pipeline_capabilities_visibility_check',
      sql`${t.visibility} IN ('customer','staff')`
    ),
    check(
      'feature_pipeline_capabilities_repository_check',
      sql`${t.repository} ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'`
    ),
    check('feature_pipeline_capabilities_repository_id_check', sql`${t.repositoryId} ~ '^[0-9]+$'`),
  ]
)
export const featurePipelineLinks = pgTable(
  'feature_pipeline_links',
  {
    postId: typeIdColumn('post')('post_id')
      .primaryKey()
      .references(() => posts.id, { onDelete: 'restrict' }),
    capabilityId: text('capability_id')
      .notNull()
      .references(() => featurePipelineCapabilities.id, { onDelete: 'restrict' }),
    taxonomyVersion: text('taxonomy_version').notNull(),
    repository: text('repository').notNull(),
    repositoryId: text('repository_id').notNull(),
    classification: text('classification').notNull(),
    phase: text('phase').notNull().default('pending'),
    issueNodeId: text('issue_node_id').unique(),
    issueNumber: integer('issue_number'),
    issueUrl: text('issue_url'),
    sourceSnapshot: jsonb('source_snapshot').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    baselinePortal: text('baseline_portal'),
    baselineGithub: text('baseline_github'),
    pendingStatus: text('pending_status'),
    lastError: text('last_error'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('feature_pipeline_links_repository_id_issue_number_key').on(
      t.repositoryId,
      t.issueNumber
    ),
    check(
      'feature_pipeline_links_classification_check',
      sql`${t.classification} IN ('feature request','enhancement')`
    ),
    check(
      'feature_pipeline_links_phase_check',
      sql`${t.phase} IN ('pending','creating','linked','held')`
    ),
    check('feature_pipeline_links_issue_number_check', sql`${t.issueNumber} > 0`),
  ]
)
export const featurePipelineAudit = pgTable(
  'feature_pipeline_audit',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    postId: typeIdColumn('post')('post_id').references(() => featurePipelineLinks.postId, {
      onDelete: 'restrict',
    }),
    event: text('event').notNull(),
    details: jsonb('details').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('feature_pipeline_audit_post_idx').on(t.postId, t.createdAt)]
)
export const featurePipelineStatusOutbox = pgTable('feature_pipeline_status_outbox', {
  eventId: uuid('event_id').primaryKey(),
  postId: typeIdColumn('post')('post_id')
    .notNull()
    .references(() => featurePipelineLinks.postId, { onDelete: 'restrict' }),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
})

export const featurePipelineLegacyPosts = pgTable('feature_pipeline_legacy_posts', {
  postId: typeIdColumn('post')('post_id')
    .primaryKey()
    .references(() => posts.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
})
