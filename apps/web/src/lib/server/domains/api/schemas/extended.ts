/**
 * Registrations for the REST endpoints the spec did not describe
 * (landing-page#2309, OpenAPI drift). Each entry documents the path, method,
 * auth level and scope, parameters and the response envelope. The drift test
 * (api/__tests__/openapi-drift.test.ts) fails when a route file under
 * routes/api/v1 has no registration here or elsewhere.
 */
import 'zod-openapi'
import { z } from 'zod'
import { registerPath, asSchema } from '../openapi'
import { UnauthorizedErrorSchema, NotFoundErrorSchema, ValidationErrorSchema } from './common'

type Method = 'get' | 'post' | 'patch' | 'delete'

const ForbiddenSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .meta({ description: 'Forbidden: role, scope, or a refused change' })

const DataSchema = z
  .object({ data: z.unknown() })
  .meta({ description: 'Response envelope; see the endpoint description for the shape of data' })

const BodySchema = z
  .record(z.string(), z.unknown())
  .meta({ description: 'JSON request body; see the endpoint description' })

interface Operation {
  tag: string
  summary: string
  description: string
  /** Minimum key role and the scope the call needs. */
  auth: { role: 'team' | 'admin'; scope: string }
  body?: boolean
  query?: Array<{ name: string; description: string }>
  status?: 200 | 201 | 204
}

function pathParams(path: string) {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const },
    description: `${m[1]} (TypeID, or slug where named so)`,
  }))
}

function register(path: string, method: Method, op: Operation) {
  const status = op.status ?? 200
  const responses: Record<string, unknown> = {
    401: {
      description: 'Unauthorized',
      content: { 'application/json': { schema: UnauthorizedErrorSchema } },
    },
    403: { description: 'Forbidden', content: { 'application/json': { schema: ForbiddenSchema } } },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: NotFoundErrorSchema } },
    },
  }
  responses[status] =
    status === 204
      ? { description: 'No content' }
      : { description: op.summary, content: { 'application/json': { schema: DataSchema } } }
  if (op.body) {
    responses[400] = {
      description: 'Validation error',
      content: { 'application/json': { schema: ValidationErrorSchema } },
    }
  }
  registerPath(path, {
    [method]: {
      tags: [op.tag],
      summary: op.summary,
      description: `${op.description}\n\nRequires a ${op.auth.role === 'admin' ? 'administrator' : 'team'} API key with the \`${op.auth.scope}\` scope.`,
      parameters: [
        ...pathParams(path),
        ...(op.query ?? []).map((q) => ({
          name: q.name,
          in: 'query' as const,
          required: false,
          schema: { type: 'string' as const },
          description: q.description,
        })),
      ],
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: asSchema(BodySchema) } },
            },
          }
        : {}),
      responses,
    },
  } as Parameters<typeof registerPath>[1])
}

const READ = (role: 'team' | 'admin' = 'team') => ({
  role,
  scope: role === 'admin' ? 'admin:workspace' : 'read:feedback',
})
const WRITE = (role: 'team' | 'admin' = 'team') => ({
  role,
  scope: role === 'admin' ? 'admin:workspace' : 'write:feedback',
})

// Posts
register('/posts/{postId}/activity', 'get', {
  tag: 'Posts',
  summary: 'List post activity',
  description: 'The activity feed of a post.',
  auth: READ(),
})
register('/posts/{postId}/merge', 'post', {
  tag: 'Posts',
  summary: 'Merge a post',
  description:
    'Merge this post into the canonical post given as `canonicalPostId` in the body. Never changes a status.',
  auth: WRITE('admin'),
  body: true,
})

// Suggestions
register('/suggestions', 'get', {
  tag: 'Suggestions',
  summary: 'List suggestions',
  description: 'AI feedback and duplicate-merge suggestions awaiting review.',
  auth: READ(),
  query: [
    { name: 'status', description: 'Suggestion status filter' },
    { name: 'type', description: 'Suggestion type filter' },
    { name: 'sort', description: 'Sort order' },
    { name: 'cursor', description: 'Pagination cursor' },
    { name: 'limit', description: 'Page size' },
  ],
})
register('/suggestions/{suggestionId}/accept', 'post', {
  tag: 'Suggestions',
  summary: 'Accept a suggestion',
  description:
    'Accept a feedback or merge suggestion. Optional `edits` (title, body, boardId) apply to a create-post suggestion; a `statusId` is refused (403 STATUS_CHANGE_NOT_ALLOWED).',
  auth: WRITE(),
  body: true,
})
register('/suggestions/{suggestionId}/dismiss', 'post', {
  tag: 'Suggestions',
  summary: 'Dismiss a suggestion',
  description: 'Dismiss a pending suggestion.',
  auth: WRITE(),
})
register('/suggestions/{suggestionId}/restore', 'post', {
  tag: 'Suggestions',
  summary: 'Restore a suggestion',
  description: 'Return a dismissed suggestion to pending.',
  auth: WRITE(),
})

// Segments
register('/segments/{slug}/members', 'post', {
  tag: 'Segments',
  summary: 'Add segment members',
  description: 'Add users (`principalIds` in the body) to a manual segment identified by slug.',
  auth: WRITE(),
  body: true,
})
register('/segments/{slug}/members', 'delete', {
  tag: 'Segments',
  summary: 'Remove segment members',
  description:
    'Remove users (`principalIds` in the body) from a manual segment identified by slug.',
  auth: WRITE(),
  body: true,
})

// Webhooks
register('/webhooks', 'get', {
  tag: 'Webhooks',
  summary: 'List webhooks',
  description: 'Every webhook of the workspace. Signing secrets are never returned.',
  auth: READ('admin'),
})
register('/webhooks', 'post', {
  tag: 'Webhooks',
  summary: 'Create a webhook',
  description:
    'Create a webhook from `url` (HTTPS), `events` and optional `boardIds`. The response carries the signing secret once.',
  auth: WRITE('admin'),
  body: true,
  status: 201,
})
register('/webhooks/{webhookId}', 'get', {
  tag: 'Webhooks',
  summary: 'Get a webhook',
  description: 'One webhook. The signing secret is never returned.',
  auth: READ('admin'),
})
register('/webhooks/{webhookId}', 'patch', {
  tag: 'Webhooks',
  summary: 'Update a webhook',
  description: 'Change `url`, `events`, `boardIds` or `status` (active or disabled).',
  auth: WRITE('admin'),
  body: true,
})
register('/webhooks/{webhookId}', 'delete', {
  tag: 'Webhooks',
  summary: 'Delete a webhook',
  description: 'Delete a webhook.',
  auth: WRITE('admin'),
  status: 204,
})
register('/webhooks/{webhookId}/rotate', 'post', {
  tag: 'Webhooks',
  summary: 'Rotate a webhook secret',
  description: 'Generate a new signing secret; the response carries it once.',
  auth: WRITE('admin'),
})

// Help Center
const HELP_READ = { role: 'team' as const, scope: 'read:article' }
const HELP_WRITE = { role: 'team' as const, scope: 'write:article' }
const HELP_ADMIN = { role: 'admin' as const, scope: 'admin:workspace' }
register('/help-center/categories', 'get', {
  tag: 'Help Center',
  summary: 'List help categories',
  description: 'Help Center categories. Answers 404 while the Help Center is off.',
  auth: HELP_READ,
})
register('/help-center/categories', 'post', {
  tag: 'Help Center',
  summary: 'Create a help category',
  description: 'Create a category. Answers 404 while the Help Center is off.',
  auth: HELP_ADMIN,
  body: true,
  status: 201,
})
register('/help-center/categories/{categoryId}', 'get', {
  tag: 'Help Center',
  summary: 'Get a help category',
  description: 'One category.',
  auth: HELP_READ,
})
register('/help-center/categories/{categoryId}', 'patch', {
  tag: 'Help Center',
  summary: 'Update a help category',
  description: 'Change a category.',
  auth: HELP_ADMIN,
  body: true,
})
register('/help-center/categories/{categoryId}', 'delete', {
  tag: 'Help Center',
  summary: 'Delete a help category',
  description: 'Delete a category.',
  auth: HELP_ADMIN,
  status: 204,
})
register('/help-center/articles', 'get', {
  tag: 'Help Center',
  summary: 'List help articles',
  description: 'Help Center articles. Answers 404 while the Help Center is off.',
  auth: HELP_READ,
})
register('/help-center/articles', 'post', {
  tag: 'Help Center',
  summary: 'Create a help article',
  description: 'Create an article.',
  auth: HELP_WRITE,
  body: true,
  status: 201,
})
register('/help-center/articles/{articleId}', 'get', {
  tag: 'Help Center',
  summary: 'Get a help article',
  description: 'One article.',
  auth: HELP_READ,
})
register('/help-center/articles/{articleId}', 'patch', {
  tag: 'Help Center',
  summary: 'Update a help article',
  description: 'Change an article.',
  auth: HELP_WRITE,
  body: true,
})
register('/help-center/articles/{articleId}', 'delete', {
  tag: 'Help Center',
  summary: 'Delete a help article',
  description: 'Delete an article.',
  auth: HELP_WRITE,
  status: 204,
})
register('/help-center/articles/{articleId}/feedback', 'post', {
  tag: 'Help Center',
  summary: 'Record article feedback',
  description: 'Record whether an article helped (`helpful` boolean in the body).',
  auth: HELP_WRITE,
  body: true,
})

// Apps (integration sidebars)
register('/apps/boards', 'get', {
  tag: 'Apps',
  summary: 'List boards for an app',
  description: 'Boards an integration sidebar may post to.',
  auth: READ(),
})
register('/apps/search', 'get', {
  tag: 'Apps',
  summary: 'Search posts for an app',
  description: 'Post search for an integration sidebar.',
  auth: READ(),
  query: [
    { name: 'q', description: 'Search text' },
    { name: 'limit', description: 'Page size' },
  ],
})
register('/apps/suggest', 'get', {
  tag: 'Apps',
  summary: 'Suggest posts for an app',
  description: 'Similar posts for text an integration is showing.',
  auth: READ(),
  query: [
    { name: 'text', description: 'Text to match' },
    { name: 'limit', description: 'Page size' },
  ],
})
register('/apps/linked', 'get', {
  tag: 'Apps',
  summary: 'List linked posts',
  description: 'Posts linked to an external record (for example a ticket).',
  auth: READ(),
  query: [
    { name: 'integrationType', description: 'Integration type' },
    { name: 'externalId', description: 'External record ID' },
  ],
})
register('/apps/posts', 'post', {
  tag: 'Apps',
  summary: 'Create a post from an app',
  description:
    'Create a post on behalf of an integration user. The post starts in the board default status; a status is never set.',
  auth: WRITE(),
  body: true,
  status: 201,
})
register('/apps/link', 'post', {
  tag: 'Apps',
  summary: 'Link a post',
  description: 'Link a post to an external record.',
  auth: WRITE(),
  body: true,
})
register('/apps/unlink', 'post', {
  tag: 'Apps',
  summary: 'Unlink a post',
  description: 'Remove a link between a post and an external record.',
  auth: WRITE(),
  body: true,
})
