/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isLoopbackHost } from './util'
import type {
  ClassifiedFrame,
  FrameIdKind,
  LogFields,
  Logger,
  LoggerOptions,
  OriginAllowlist,
  OriginAllowlistOptions,
} from './types'

/**
 * Field keys that may be logged. Everything else is dropped so no payload data
 * leaks into a log line.
 */
const ALLOWED_FIELDS = new Set(['event', 'method', 'id', 'origin', 'host', 'port', 'code', 'errorCode', 'url'])

/**
 * Keep only allowlisted keys whose values are scalars (string/number/boolean).
 */
const filterScalars = (fields?: LogFields): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {}
  if (!fields) return out
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_FIELDS.has(key)) continue
    const value = fields[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  return out
}

/** Render a filtered field set as a compact `key=value` suffix. */
const renderFields = (fields: Record<string, string | number | boolean>): string =>
  Object.keys(fields)
    .map((key) => `${key}=${fields[key]}`)
    .join(' ')

/**
 * PII-safe structured logger writing to the injected sink (stderr) only. In
 * `--json` mode each call emits one JSON line `{event, ...fields}`; otherwise a
 * compact human line. `verbose=false` suppresses info detail but keeps
 * warn/error. `banner()` prints the readiness line.
 */
const makeLogger = ({ json, verbose, sink }: LoggerOptions): Logger => {
  const write = (level: string, event: string, fields?: LogFields): void => {
    const scalars = filterScalars(fields)
    if (json) {
      sink.write(`${JSON.stringify({ level, event, ...scalars })}\n`)
      return
    }
    const suffix = renderFields(scalars)
    sink.write(`[${level}] ${event}${suffix ? ` ${suffix}` : ''}\n`)
  }

  return {
    info(event: string, fields?: LogFields): void {
      if (!verbose) return
      write('info', event, fields)
    },
    warn(event: string, fields?: LogFields): void {
      write('warn', event, fields)
    },
    error(event: string, fields?: LogFields): void {
      write('error', event, fields)
    },
    /**
     * Print the readiness line. Text mode prints the bare URL; JSON mode emits
     * `{event:'listening'|'mcp-listening',url}` keyed off the scheme.
     */
    banner(url: string): void {
      if (json) {
        const event = url.startsWith('http') ? 'mcp-listening' : 'listening'
        sink.write(`${JSON.stringify({ event, url })}\n`)
        return
      }
      sink.write(`${url}\n`)
    },
  }
}

/**
 * Normalize an Origin string to `scheme://host[:port]` (no path/trailing
 * slash), or null if it can't be parsed.
 */
const normalizeOrigin = (origin: string): string | null => {
  try {
    const parsed = new URL(origin)
    return parsed.port
      ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}`
      : `${parsed.protocol}//${parsed.hostname}`
  } catch {
    return null
  }
}

/**
 * Build the Origin gate predicate. Always-true when `allowAnyOrigin`; otherwise
 * true iff the Origin is absent (non-browser client), its host is loopback, or
 * it exactly matches a normalized `allowOrigins` entry. A malformed Origin is
 * rejected (unless allowAnyOrigin).
 */
const buildOriginAllowlist = ({ allowOrigins, allowAnyOrigin }: OriginAllowlistOptions): OriginAllowlist => {
  if (allowAnyOrigin) return () => true
  const allowed = new Set(allowOrigins.map(normalizeOrigin).filter((o) => o !== null))
  return (origin) => {
    if (origin === undefined || origin === '') return true
    const normalized = normalizeOrigin(origin)
    if (!normalized) return false
    if (allowed.has(normalized)) return true
    return isLoopbackHost(new URL(normalized).hostname)
  }
}

/**
 * Extract ONLY the JSON-RPC method name from a parsed frame for logging.
 * Returns 'unknown' if absent. Never returns params/result/payload.
 */
const classifyMethod = (frame: unknown): string => {
  if (typeof frame === 'object' && frame !== null) {
    const method = (frame as { method?: unknown }).method
    if (typeof method === 'string') return method
  }
  return 'unknown'
}

/**
 * Classify a JSON-RPC frame's id into a non-identifying shape token, never the
 * id value itself: 'request' (has id + method), 'response' (has id, no method),
 * 'notification' (method, no id), or 'absent'.
 */
const classifyId = (frame: unknown): FrameIdKind => {
  if (typeof frame !== 'object' || frame === null) return 'absent'
  const obj = frame as { id?: unknown; method?: unknown }
  const hasId = obj.id !== undefined && obj.id !== null
  const hasMethod = typeof obj.method === 'string'
  if (hasId && hasMethod) return 'request'
  if (hasId) return 'response'
  if (hasMethod) return 'notification'
  return 'absent'
}

/**
 * PII-safe classification of a parsed (or null) frame into the `{ method, id }`
 * shape both faces log. A null/non-object frame yields the inert
 * `{ method: 'unknown', id: 'absent' }` fallback (exactly what classifyMethod /
 * classifyId already return for null). Never returns params/result/payload.
 */
const classifyFrame = (frame: unknown): ClassifiedFrame => ({ method: classifyMethod(frame), id: classifyId(frame) })

/**
 * Parse-then-classify a raw NDJSON string into the PII-safe `{ method, id }`
 * shape; a parse failure yields the inert `{ method: 'unknown', id: 'absent' }`
 * fallback. Never throws and never returns the raw body.
 */
const safeClassifyFrame = (raw: string): ClassifiedFrame => {
  try {
    return classifyFrame(JSON.parse(raw))
  } catch {
    return classifyFrame(null)
  }
}

export { makeLogger, buildOriginAllowlist, classifyMethod, classifyId, classifyFrame, safeClassifyFrame }
