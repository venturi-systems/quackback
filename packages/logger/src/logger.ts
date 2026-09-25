/**
 * Structured application logger (Pino) — shared across the workspace.
 *
 * Emits flat NDJSON to stdout — one JSON object per line — for ingestion by a
 * log shipper (Grafana Alloy, Promtail, Fluent Bit, Vector, ...). Every line
 * carries:
 *   - service_name                 (static binding)
 *   - level (string), time, msg    (Pino, string level for level detection)
 *   - request_id, route, tenant_id, user_id   (from the shared ALS context)
 *   - trace_id, span_id            (from the active OpenTelemetry span, if any)
 *
 * `service_name` defaults from OTEL_SERVICE_NAME (else "quackback"); each app
 * passes its own via `base`. Do NOT use an in-process Pino transport in
 * production (fragile under Bun) — write NDJSON to stdout and let the collector
 * ship it.
 *
 * Server-only: imports pino + node:async_hooks (via ./context).
 */
import pino from 'pino'
import { context, trace } from '@opentelemetry/api'
import { getLogContext } from './context'
import {
  sanitizeLogArguments,
  sanitizeLogFields,
  scrubLogLine,
  serializeError,
} from './error-serializer'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

/**
 * Secret/PII paths stripped from every log line. Redaction is a backstop —
 * the primary rule is "log IDs, not payloads". `remove: true` drops the key
 * entirely so secrets never reach the log store.
 */
const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'apiKey',
  '*.apiKey',
  'api_key',
  'secret',
  '*.secret',
  'widgetSecret',
  'email',
  '*.email',
  'user.email',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  // Hyphenated keys require bracket notation in Pino redact paths; bare/dotted
  // `set-cookie` only catches the top level and leaks nested header locations.
  // set-cookie is a response header, so cover the realistic shapes.
  '["set-cookie"]',
  'headers["set-cookie"]',
  'req.headers["set-cookie"]',
  'request.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'response.headers["set-cookie"]',
  // A failed query's bound values (drizzle-orm `params`, postgres.js
  // `parameters`). The err serializer never writes them (DEF-63); these paths
  // are the second layer should an error of another shape carry them.
  'err.params',
  'err.parameters',
]

/**
 * Merge ambient request context + active trace context into every line.
 * Reads the OTel active span defensively: when no SDK/span is active,
 * `trace.getSpan` returns undefined and no trace fields are added — so this is
 * a no-op until tracing is wired, then logs auto-correlate to Tempo.
 */
function mixin(): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...getLogContext() }
  const span = trace.getSpan(context.active())
  if (span) {
    const sc = span.spanContext()
    if (sc.traceId) {
      fields.trace_id = sc.traceId
      fields.span_id = sc.spanId
    }
  }
  return fields
}

export interface CreateLoggerOptions {
  level?: LogLevel
  /** Override the destination stream (tests capture output this way). */
  destination?: pino.DestinationStream
  /** Extra static bindings merged into every line (e.g. service_name). */
  base?: Record<string, unknown>
}

function defaultLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase()
  const allowed: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']
  // info everywhere except tests, which default to silent to keep test output
  // clean (LOG_LEVEL still overrides). Bump to debug locally when tracing.
  const fallback: LogLevel = process.env.NODE_ENV === 'test' ? 'silent' : 'info'
  if (!raw) return fallback
  if ((allowed as string[]).includes(raw)) return raw as LogLevel
  console.warn(`[logger] invalid LOG_LEVEL "${raw}", falling back to ${fallback}`)
  return fallback
}

/** Opaque logger type — use this instead of importing directly from pino. */
export type AppLogger = pino.Logger

/** Bindings made safe the way `formatters.log` makes log fields safe. */
function sanitizeBindings(bindings: unknown): unknown {
  return bindings !== null && typeof bindings === 'object'
    ? sanitizeLogFields(bindings as Record<string, unknown>)
    : bindings
}

/**
 * Pino writes a child logger's bindings (`logger.child({ ... })`,
 * `setBindings`) once, when they are set, through the serializers and the
 * bindings formatter only: `formatters.log` never sees them, and pino gives
 * every child its own pass-through bindings formatter. So
 * `logger.child({ error })` would write a failed query's enumerable `params`,
 * and a bound string with a failed query's text would be written as it is
 * (DEF-63). Both methods are wrapped here, on the root logger, to sanitize
 * bindings first; pino creates each child from its parent with
 * `Object.create`, so every descendant inherits the wrappers.
 */
function sanitizeChildBindings(logger: pino.Logger): pino.Logger {
  const child = logger.child
  const setBindings = logger.setBindings
  logger.child = function (this: pino.Logger, bindings: unknown, childOptions?: unknown) {
    return Reflect.apply(child, this, [sanitizeBindings(bindings), childOptions])
  } as unknown as pino.Logger['child']
  logger.setBindings = function (this: pino.Logger, bindings: unknown) {
    Reflect.apply(setBindings, this, [sanitizeBindings(bindings)])
  } as unknown as pino.Logger['setBindings']
  return logger
}

/**
 * Build a logger instance. Consumers usually pass `base.service_name`; the
 * default falls back to OTEL_SERVICE_NAME then "quackback".
 */
export function createLogger(options: CreateLoggerOptions = {}): pino.Logger {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'quackback'

  const pinoOptions: pino.LoggerOptions = {
    level: options.level ?? defaultLevel(),
    base: { service_name: serviceName, ...options.base },
    formatters: {
      // String level (e.g. "info") so Grafana/Loki level detection works.
      level: (label) => ({ level: label }),
      // Errors under any other key, or nested in plain objects, get the same
      // serializer as `err`; a failed query's text is cut out of strings.
      log: sanitizeLogFields,
      // The same for this logger's own bindings (`base`). A child's bindings
      // are sanitized by `sanitizeChildBindings`.
      bindings: sanitizeLogFields,
    },
    redact: { paths: REDACT_PATHS, remove: true },
    // pino's standard serializer, except that a failed query anywhere in reach
    // is reduced to its statement, SQLSTATE and identifiers (DEF-63).
    serializers: { err: serializeError },
    hooks: {
      // A call that passes an error and no message would log the error's own
      // message, which for a failed query is the SQL and every bound value.
      logMethod(args, method) {
        const write = method as unknown as (...logArgs: unknown[]) => void
        write.apply(this, sanitizeLogArguments(args))
      },
      // The last layer: whatever the layers above did not reach, no finished
      // line leaves with a failed query's text in it.
      streamWrite: scrubLogLine,
    },
    mixin,
  }

  const logger = options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions)
  return sanitizeChildBindings(logger)
}
