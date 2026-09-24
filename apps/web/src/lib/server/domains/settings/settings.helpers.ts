/**
 * Internal shared helpers for settings sub-modules.
 * NOT part of the public API — import from settings.service instead.
 */
import { db } from '@/lib/server/db'
import { cacheDel, CACHE_KEYS } from '@/lib/server/redis'
import { NotFoundError, InternalError, ValidationError } from '@/lib/shared/errors'
import { sanitizeTiptapContent } from '@/lib/server/sanitize-tiptap'
import { logger } from '@/lib/server/logger'
import {
  DEFAULT_PORTAL_CONFIG,
  PORTAL_WELCOME_CARD_TITLE_MAX,
  type PortalWelcomeCard,
} from './settings.types'

const log = logger.child({ component: 'settings-helpers' })

export type SettingsRecord = NonNullable<Awaited<ReturnType<typeof db.query.settings.findFirst>>>

/** @internal */
export function parseJsonConfig<T extends object>(json: string | null, defaultValue: T): T {
  if (!json) return defaultValue
  try {
    return deepMerge(defaultValue, JSON.parse(json))
  } catch {
    return defaultValue
  }
}

/** @internal */
export function parseJsonOrNull<T>(json: string | null): T | null {
  if (!json) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

/**
 * Keys deepMerge never copies. `JSON.parse('{"__proto__":{...}}')` creates an
 * ordinary own `__proto__` key, and assigning it onto the merged object would
 * run the `__proto__` setter and replace that object's prototype, so every key
 * the payload supplied would read through as an inherited setting.
 * `constructor` and `prototype` are skipped as defence in depth; no settings
 * shape uses them.
 */
const UNSAFE_MERGE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** A `{}`-style object (including a null-prototype one), never an array or class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** @internal */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target }
  // Own keys only: `for...in` would also merge keys inherited by `source`.
  // `?? {}` keeps a stored JSON `null` merging to the defaults, as before.
  for (const key of Object.keys(source ?? {}) as Array<keyof T & string>) {
    if (UNSAFE_MERGE_KEYS.has(key)) continue
    const srcVal = source[key]
    if (srcVal === undefined) continue
    // Read only the merged object's own value, never an inherited one.
    const tgtVal = Object.hasOwn(result, key) ? result[key] : undefined
    const isNestedObject =
      typeof srcVal === 'object' &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === 'object' &&
      tgtVal !== null

    if (isNestedObject) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      ) as T[typeof key]
    } else if (isPlainObject(srcVal)) {
      // Nothing to merge into: copy the subtree through deepMerge instead of by
      // reference, so an unsafe key nested at any depth is dropped here rather
      // than kept and later written to the database by JSON.stringify.
      result[key] = deepMerge<Record<string, unknown>>({}, srcVal) as T[typeof key]
    } else {
      result[key] = srcVal as T[typeof key]
    }
  }
  return result
}

/** @internal */
export async function requireSettings(): Promise<SettingsRecord> {
  const org = await db.query.settings.findFirst()
  if (!org) throw new NotFoundError('SETTINGS_NOT_FOUND', 'Settings not found')
  return org
}

/** @internal */
export function wrapDbError(operation: string, error: unknown): never {
  if (error instanceof NotFoundError || error instanceof ValidationError) throw error
  const message = error instanceof Error ? error.message : 'Unknown error'
  throw new InternalError('DATABASE_ERROR', `Failed to ${operation}: ${message}`, error)
}

/** @internal */
export async function invalidateSettingsCache(): Promise<void> {
  log.info('invalidating settings cache')
  await cacheDel(CACHE_KEYS.TENANT_SETTINGS)
}

/**
 * Merge a partial `welcomeCard` update into the stored card. Unlike
 * {@link deepMerge}, the `body` field is replaced wholesale — a TipTap
 * doc with no `content` must clear the previous content, not retain it.
 *
 * @internal
 */
export function mergeWelcomeCard(
  existing: PortalWelcomeCard | undefined,
  input: Partial<PortalWelcomeCard> | undefined
): PortalWelcomeCard {
  const base = existing ?? DEFAULT_PORTAL_CONFIG.welcomeCard!
  if (!input) return existing ?? base
  return { ...base, ...input }
}

/**
 * Project a stored welcome card for public consumption. Disabled cards
 * have draft title/body that must not leak through the public portal
 * config endpoint.
 *
 * @internal
 */
export function publicWelcomeCard(
  card: PortalWelcomeCard | undefined
): PortalWelcomeCard | undefined {
  if (!card?.enabled) return undefined
  return card
}

/**
 * Normalize a partial `welcomeCard` update before it's merged into stored
 * portalConfig. Trims the title, enforces the length cap, and runs the
 * TipTap body through the standard sanitizer.
 *
 * @internal
 */
export function normalizeWelcomeCardInput(
  input: Partial<PortalWelcomeCard> | undefined
): Partial<PortalWelcomeCard> | undefined {
  if (!input) return input
  const normalized: Partial<PortalWelcomeCard> = { ...input }
  if (typeof input.title === 'string') {
    const trimmed = input.title.trim()
    if (trimmed.length > PORTAL_WELCOME_CARD_TITLE_MAX) {
      throw new ValidationError(
        'WELCOME_CARD_TITLE_TOO_LONG',
        `Welcome card title must be ${PORTAL_WELCOME_CARD_TITLE_MAX} characters or fewer`
      )
    }
    normalized.title = trimmed
  }
  if (input.body !== undefined) {
    normalized.body = sanitizeTiptapContent(input.body)
  }
  return normalized
}
