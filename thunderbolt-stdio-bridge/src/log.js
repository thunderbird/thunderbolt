/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const { isLoopbackHost } = require('./util')

/**
 * Field keys that may be logged. Everything else is dropped so no payload data
 * leaks into a log line.
 * @type {Set<string>}
 */
const ALLOWED_FIELDS = new Set(['event', 'method', 'id', 'origin', 'host', 'port', 'code', 'errorCode', 'url'])

/**
 * Keep only allowlisted keys whose values are scalars (string/number/boolean).
 * @param {Record<string, unknown>|undefined} fields
 * @returns {Record<string, string|number|boolean>}
 */
const filterScalars = (fields) => {
  const out = {}
  if (!fields) return out
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_FIELDS.has(key)) continue
    const value = fields[key]
    const type = typeof value
    if (type === 'string' || type === 'number' || type === 'boolean') out[key] = value
  }
  return out
}

/** Render a filtered field set as a compact `key=value` suffix. */
const renderFields = (fields) =>
  Object.keys(fields)
    .map((key) => `${key}=${fields[key]}`)
    .join(' ')

/**
 * PII-safe structured logger writing to the injected sink (stderr) only. In
 * `--json` mode each call emits one JSON line `{event, ...fields}`; otherwise a
 * compact human line. `verbose=false` suppresses info detail but keeps
 * warn/error. `banner()` prints the readiness line.
 * @param {{ json: boolean, verbose: boolean, sink: NodeJS.WritableStream }} opts
 */
const makeLogger = ({ json, verbose, sink }) => {
  const write = (level, event, fields) => {
    const scalars = filterScalars(fields)
    if (json) {
      sink.write(`${JSON.stringify({ level, event, ...scalars })}\n`)
      return
    }
    const suffix = renderFields(scalars)
    sink.write(`[${level}] ${event}${suffix ? ` ${suffix}` : ''}\n`)
  }

  return {
    /**
     * @param {string} event
     * @param {Record<string, string|number|boolean>} [fields]
     */
    info(event, fields) {
      if (!verbose) return
      write('info', event, fields)
    },
    /**
     * @param {string} event
     * @param {Record<string, string|number|boolean>} [fields]
     */
    warn(event, fields) {
      write('warn', event, fields)
    },
    /**
     * @param {string} event
     * @param {Record<string, string|number|boolean>} [fields]
     */
    error(event, fields) {
      write('error', event, fields)
    },
    /**
     * Print the readiness line. Text mode prints the bare URL; JSON mode emits
     * `{event:'listening'|'mcp-listening',url}` keyed off the scheme.
     * @param {string} url
     */
    banner(url) {
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
 * @param {string} origin
 * @returns {string|null}
 */
const normalizeOrigin = (origin) => {
  const parsed = URL.canParse(origin) ? new URL(origin) : null
  if (!parsed) return null
  return parsed.port
    ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}`
    : `${parsed.protocol}//${parsed.hostname}`
}

/**
 * Build the Origin gate predicate. Always-true when `allowAnyOrigin`; otherwise
 * true iff the Origin is absent (non-browser client), its host is loopback, or
 * it exactly matches a normalized `allowOrigins` entry. A malformed Origin is
 * rejected (unless allowAnyOrigin).
 * @param {{ allowOrigins: string[], allowAnyOrigin: boolean }} opts
 * @returns {(origin: string|undefined) => boolean}
 */
const buildOriginAllowlist = ({ allowOrigins, allowAnyOrigin }) => {
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
 * @param {unknown} frame
 * @returns {string}
 */
const classifyMethod = (frame) => {
  if (typeof frame === 'object' && frame !== null) {
    const method = /** @type {{ method?: unknown }} */ (frame).method
    if (typeof method === 'string') return method
  }
  return 'unknown'
}

/**
 * Classify a JSON-RPC frame's id into a non-identifying shape token, never the
 * id value itself: 'request' (has id + method), 'response' (has id, no method),
 * 'notification' (method, no id), or 'absent'.
 * @param {unknown} frame
 * @returns {'request'|'response'|'notification'|'absent'}
 */
const classifyId = (frame) => {
  if (typeof frame !== 'object' || frame === null) return 'absent'
  const obj = /** @type {{ id?: unknown, method?: unknown }} */ (frame)
  const hasId = obj.id !== undefined && obj.id !== null
  const hasMethod = typeof obj.method === 'string'
  if (hasId && hasMethod) return 'request'
  if (hasId) return 'response'
  if (hasMethod) return 'notification'
  return 'absent'
}

module.exports = {
  makeLogger,
  buildOriginAllowlist,
  classifyMethod,
  classifyId,
  normalizeOrigin,
}
