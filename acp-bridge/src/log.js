/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * PII-safe logging for acp-bridge.
 *
 * The cardinal rule: log objects are built from an ALLOWLIST of extracted
 * scalars. The raw ACP frame is NEVER handed to the logger, so prompt text,
 * tool output, file paths, tokens, and argv can never leak — there is no code
 * path that copies the frame body into a log line.
 *
 * Allowlisted fields: timestamp, direction, kind, method (validated enum),
 * id, byteSize, status, errorCode, lifecycle, closeCode, origin (sanitized).
 */

/** Known ACP method names. Anything else is collapsed to 'other' so a method
 *  string (which is structural, not content) can't smuggle data into a log. */
const KNOWN_METHODS = new Set([
  'initialize',
  'authenticate',
  'session/new',
  'session/load',
  'session/prompt',
  'session/cancel',
  'session/update',
  'session/request_permission',
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/release',
  'terminal/wait_for_exit',
  'terminal/kill',
])

/**
 * Coerce an arbitrary method string to the known enum or 'other'.
 * @param {unknown} method
 * @returns {string | undefined}
 */
const safeMethod = (method) => {
  if (typeof method !== 'string') return undefined
  return KNOWN_METHODS.has(method) ? method : 'other'
}

/** Max length of a string id before it's truncated. A JSON-RPC id is meant to
 *  be structural, but it can be an arbitrary string — an agent could embed
 *  content there. Numbers are inherently bounded and pass through untouched. */
const MAX_ID_LEN = 16

/**
 * Coerce a JSON-RPC id to a safe scalar (string/number only). Objects/arrays
 * are dropped — an id is structural, but we still refuse to serialize anything
 * non-scalar into a log line. Numbers pass through; a string longer than
 * MAX_ID_LEN is truncated to its first 8 chars + '…' so no realistic content
 * can be exfiltrated through the id field.
 * @param {unknown} id
 * @returns {string | number | undefined}
 */
const safeId = (id) => {
  if (typeof id === 'number') return id
  if (typeof id !== 'string') return undefined
  return id.length > MAX_ID_LEN ? `${id.slice(0, 8)}…` : id
}

/**
 * Classify a parsed JSON-RPC object into a kind without reading its payload.
 * @param {Record<string, unknown>} obj
 * @returns {'request' | 'response' | 'notification' | 'error'}
 */
const classifyKind = (obj) => {
  if ('error' in obj) return 'error'
  if ('method' in obj) return 'id' in obj ? 'request' : 'notification'
  return 'response'
}

/**
 * Extract a PII-safe log event from a single ACP/JSON-RPC frame.
 *
 * Returns ONLY allowlisted scalars. The frame's params/result/error.data
 * (which hold prompts, tool output, file contents, paths) are never read.
 *
 * @param {object} args
 * @param {'agent->ws' | 'ws->agent'} args.direction
 * @param {string} args.line - the raw ndjson line (used only for byteSize)
 * @returns {{
 *   direction: string,
 *   kind: string,
 *   method?: string,
 *   id?: string | number,
 *   byteSize: number,
 *   status?: 'ok' | 'error',
 *   errorCode?: number,
 *   parseError?: true,
 * }}
 */
export const extractLogEvent = ({ direction, line }) => {
  const byteSize = Buffer.byteLength(line, 'utf8')

  const parsed = tryParse(line)
  if (parsed === undefined) {
    return { direction, kind: 'non-json', byteSize, parseError: true }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Valid JSON but not a JSON-RPC object — still no content extracted.
    return { direction, kind: 'non-rpc', byteSize }
  }

  const obj = /** @type {Record<string, unknown>} */ (parsed)
  const kind = classifyKind(obj)

  const event = {
    direction,
    kind,
    byteSize,
    method: safeMethod(obj.method),
    id: safeId(obj.id),
  }

  if (kind === 'error') {
    const errorObj = obj.error
    const errorCode =
      errorObj && typeof errorObj === 'object' && typeof (/** @type {Record<string, unknown>} */ (errorObj).code) === 'number'
        ? /** @type {number} */ (/** @type {Record<string, unknown>} */ (errorObj).code)
        : undefined
    return { ...event, status: 'error', errorCode }
  }

  if (kind === 'response') {
    return { ...event, status: 'ok' }
  }

  return event
}

/**
 * Parse JSON, returning `undefined` on failure (so callers can distinguish a
 * parse failure from a legitimate `null` value).
 * @param {string} line
 * @returns {unknown | undefined}
 */
const tryParse = (line) => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * Sanitize an Origin header for logging. Keeps only the scheme + host:port
 * structure (which is what we care about for handshake diagnostics) and never
 * logs a path/query that could carry data.
 * @param {unknown} origin
 * @returns {string}
 */
export const sanitizeOrigin = (origin) => {
  if (typeof origin !== 'string' || origin.length === 0) return 'none'
  try {
    const url = new URL(origin)
    return `${url.protocol}//${url.host}`
  } catch {
    return 'invalid'
  }
}

/**
 * Default WebSocket Origin allowlist — the Thunderbolt app origins.
 *
 * Browser WebSocket connections are NOT same-origin-protected, so without this
 * check any web page open on the machine could connect to ws://127.0.0.1:PORT
 * and drive the user's local agent (fs read/write, terminal exec). These are the
 * canonical Thunderbolt origins (see backend/src/config/settings.ts corsOrigins
 * + the hardcoded prod web origin in isOAuthRedirectUriAllowed):
 *   - https://app.thunderbolt.io  — production web app
 *   - tauri://localhost / http://tauri.localhost — Tauri desktop/mobile webview
 *   - http://localhost:1420 (+ http://127.0.0.1:1420, http://[::1]:1420) — Vite dev server (web + Tauri dev)
 * A missing/empty Origin is allowed separately (native/Tauri webviews often send
 * none); see isOriginAllowed.
 */
export const defaultAllowedOrigins = Object.freeze([
  'https://app.thunderbolt.io',
  'tauri://localhost',
  'http://tauri.localhost',
  // Vite dev server (web + Tauri dev). It binds loopback and is reachable by
  // every loopback spelling, so accept all three — same local origin.
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'http://[::1]:1420',
])

/**
 * Decide whether an incoming WebSocket Origin may connect.
 *
 * A missing/empty Origin is allowed: native/Tauri webviews frequently send no
 * Origin header, and a non-browser client (which is not subject to the
 * cross-origin hijack this guards against) likewise sends none. A present Origin
 * must exactly match an entry in the allowlist (scheme + host:port), normalized
 * the same way as sanitizeOrigin so a trailing slash or default port can't slip
 * past or be falsely rejected.
 *
 * @param {unknown} origin - the raw Origin header (or undefined)
 * @param {readonly string[]} allowlist - exact-match allowed origins
 * @returns {boolean}
 */
export const isOriginAllowed = (origin, allowlist) => {
  if (typeof origin !== 'string' || origin.length === 0) return true
  const normalized = normalizeOrigin(origin)
  if (normalized === null) return false
  return allowlist.some((allowed) => normalizeOrigin(allowed) === normalized)
}

/**
 * Normalize an origin to `scheme://host[:port]` for exact comparison, or null if
 * it isn't a parseable origin.
 * @param {string} origin
 * @returns {string | null}
 */
const normalizeOrigin = (origin) => {
  try {
    const url = new URL(origin)
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Create a minimal, dependency-free, PII-safe structured logger.
 *
 * - `json: true`  → one JSON object per line (raw scalars).
 * - `json: false` → a compact, human one-liner with NO content column.
 * - `verbose`     → enables debug-level (per-frame) events.
 *
 * Always writes to the provided stream (stderr in production) so the agent's
 * own stdout/ACP traffic is never polluted.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.json]
 * @param {boolean} [opts.verbose]
 * @param {{ write: (s: string) => void }} [opts.stream]
 * @returns {{
 *   debug: (event: Record<string, unknown>) => void,
 *   info: (event: Record<string, unknown>) => void,
 *   warn: (event: Record<string, unknown>) => void,
 *   error: (event: Record<string, unknown>) => void,
 * }}
 */
export const createLogger = ({ json = false, verbose = false, stream } = {}) => {
  const out = stream ?? process.stderr
  const threshold = verbose ? LEVELS.debug : LEVELS.info

  const write = (level, event) => {
    if (LEVELS[level] < threshold) return
    const record = { level, ...event }
    out.write(json ? `${JSON.stringify(record)}\n` : `${formatPretty(record)}\n`)
  }

  return {
    debug: (event) => write('debug', event),
    info: (event) => write('info', event),
    warn: (event) => write('warn', event),
    error: (event) => write('error', event),
  }
}

/**
 * Render a safe log record as a compact one-liner. Only iterates the record's
 * own scalar keys — there is no content column and nothing nested is expanded.
 * @param {Record<string, unknown>} record
 * @returns {string}
 */
const formatPretty = (record) => {
  const { level, ...rest } = record
  const tag = String(level).toUpperCase().padEnd(5)
  const fields = Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  return `${tag} ${fields}`.trimEnd()
}
