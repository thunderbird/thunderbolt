// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The MCP Streamable HTTP face. Stands up a bare @modelcontextprotocol/sdk
// StreamableHTTPServerTransport behind a minimal http.createServer on host:port
// (default 127.0.0.1) and bridges it to the spawned stdio MCP child: HTTP-side
// JSON-RPC messages are written to the child as NDJSON (relay.wsToFrame) and the
// child's NDJSON stdout lines are pushed back to HTTP clients (transport.send).
// Enforces bearer-before-route, CORS per the Origin allowlist, a request body
// cap, and deterministic never-orphan teardown. Prints the
// `http://127.0.0.1:PORT/mcp` banner to stderr once listening.

'use strict'

const { createServer: defaultCreateServer } = require('node:http')
const { createHash, timingSafeEqual } = require('node:crypto')
const { randomUUID } = require('node:crypto')
const {
  StreamableHTTPServerTransport: DefaultStreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { UnavailableError } = require('./errors')
const { buildOriginAllowlist, classifyMethod, classifyId } = require('./log')
const { createNdjsonReader, wsToFrame } = require('./relay')
const { superviseChild: defaultSuperviseChild } = require('./child')
const { formatHostForUrl } = require('./util')

/** Default request body cap: 4 MiB. Larger POST bodies are rejected with 413. */
const DEFAULT_BODY_CAP_BYTES = 4 << 20
/** The single MCP endpoint path the face serves. */
const MCP_PATH = '/mcp'
/** Methods the transport handles on /mcp. Everything else is 404. */
const MCP_METHODS = new Set(['POST', 'GET', 'DELETE'])

/**
 * Constant-time bearer comparison that never leaks length. Both tokens are
 * SHA-256 digested to fixed 32-byte buffers before timingSafeEqual, so unequal
 * input lengths can never throw or short-circuit.
 * @param {string|undefined} provided
 * @param {string} expected
 * @returns {boolean}
 */
const bearerMatches = (provided, expected) => {
  if (typeof provided !== 'string') return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Extract the `Bearer <token>` value from an Authorization header, or undefined. */
const readBearer = (req) => {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer (.+)$/.exec(header)
  return match ? match[1] : undefined
}

/** Reply with a status code and no body leak. */
const replyStatus = (res, status) => {
  res.writeHead(status)
  res.end()
}

/** Sentinel returned by readBody when the aggregate body exceeds the cap. */
const BODY_TOO_LARGE = Symbol('body-too-large')
/** Sentinel returned by readBody when the client aborts mid-body (error/early close). */
const BODY_ABORTED = Symbol('body-aborted')
/** Sentinel returned by parseBody for a non-empty body that isn't valid JSON. */
const MALFORMED = Symbol('malformed-body')

/**
 * Parse a POST body to a JSON value. An empty body → undefined (a bodyless GET-
 * style POST); a non-empty body that isn't valid JSON → the MALFORMED sentinel
 * so the caller answers 400 instead of crashing the handler.
 * @param {string} body
 * @returns {unknown}
 */
const parseBody = (body) => {
  if (body === '') return undefined
  try {
    return JSON.parse(body)
  } catch {
    return MALFORMED
  }
}

/**
 * Read the request body up to `cap` bytes. Resolves the buffered string, the
 * BODY_TOO_LARGE sentinel once the aggregate exceeds the cap, or the BODY_ABORTED
 * sentinel if the client aborts mid-body (socket error, or close before 'end').
 * It NEVER rejects (a rejection here is an unawaited promise on the http 'request'
 * listener — Node's default unhandledRejection would kill the process without
 * reaping the child, orphaning it) and never hangs (a premature 'close' that
 * never emits 'end' resolves BODY_ABORTED). On overflow it stops buffering and
 * drains the rest of the stream (req.resume) so the socket stays healthy and the
 * caller's 413 response flushes cleanly — it does NOT destroy the socket (that
 * would surface as a client-side connection error).
 * @param {import('node:http').IncomingMessage} req
 * @param {number} cap
 * @returns {Promise<string|typeof BODY_TOO_LARGE|typeof BODY_ABORTED>}
 */
const readBody = (req, cap) =>
  new Promise((resolve) => {
    const chunks = []
    let size = 0
    let overflowed = false
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (overflowed) return
      size += chunk.length
      if (size > cap) {
        overflowed = true
        chunks.length = 0
        req.resume() // drain remaining bytes without buffering
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(overflowed ? BODY_TOO_LARGE : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => settle(BODY_ABORTED))
    // 'close' fires after 'end' on a clean request (settle() is then a no-op); a
    // 'close' before 'end' means the client aborted ⇒ resolve BODY_ABORTED.
    req.on('close', () => settle(BODY_ABORTED))
  })

/**
 * Start the MCP Streamable HTTP face: bind, spawn the child MCP stdio server,
 * connect a bare StreamableHTTPServerTransport, and relay JSON-RPC between the
 * HTTP face and the child's NDJSON stdio. Bearer-before-route, CORS, body cap,
 * deterministic teardown, never-orphan.
 *
 * @param {Object} opts
 * @param {string[]} opts.launch - child launch argv.
 * @param {string} opts.host
 * @param {number} opts.port - 0 => OS-assigned ephemeral.
 * @param {string} [opts.bearer] - when set (always under --tunnel), gates every route.
 * @param {string[]} opts.allowOrigins
 * @param {boolean} opts.allowAnyOrigin
 * @param {number} [opts.bodyCapBytes]
 * @param {Object} opts.logger
 * @param {(info: {code: number|null, signal: string|null}) => void} [opts.onChildExit]
 *   - notified when the child exits so the caller can derive its exit code.
 * @param {Object} [opts.deps] - injectable { createServer, StreamableHTTPServerTransport, superviseChild, spawn }.
 * @returns {Promise<{ url: string, kill(): void, close(): Promise<void> }>}
 */
const startMcpFace = ({
  launch,
  host,
  port,
  bearer,
  allowOrigins,
  allowAnyOrigin,
  bodyCapBytes = DEFAULT_BODY_CAP_BYTES,
  logger,
  onChildExit,
  deps = {},
}) => {
  const createServer = deps.createServer ?? defaultCreateServer
  const StreamableHTTPServerTransport = deps.StreamableHTTPServerTransport ?? DefaultStreamableHTTPServerTransport
  const superviseChild = deps.superviseChild ?? defaultSuperviseChild
  const isOriginAllowed = buildOriginAllowlist({ allowOrigins, allowAnyOrigin })

  return new Promise((resolve, reject) => {
    const closers = { settled: false, resolveClose: null }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })

    // HTTP -> child: every JSON-RPC message the transport surfaces is written to
    // the child's stdin as one NDJSON line. Malformed (unserializable) frames are
    // dropped and logged by method/id only — the raw frame is never logged.
    transport.onmessage = (message) => {
      try {
        supervisor.writeStdin(wsToFrame(JSON.stringify(message)))
      } catch {
        logger.warn('drop-http-frame', { method: classifyMethod(message), id: classifyId(message) })
      }
    }

    // child stdout NDJSON -> HTTP: each complete line is parsed and pushed to the
    // transport, which routes it to the correct pending HTTP/SSE response.
    const reader = createNdjsonReader((line) => {
      const message = (() => {
        try {
          return JSON.parse(line)
        } catch {
          logger.warn('drop-child-frame', { method: 'unknown', id: 'absent' })
          return null
        }
      })()
      if (message) transport.send(message)
    })

    const server = createServer()

    const finishClose = () => {
      if (closers.settled) return
      closers.settled = true
      if (closers.resolveClose) closers.resolveClose()
    }

    const supervisor = superviseChild({
      launch,
      spawn: deps.spawn,
      logger,
      onStdout: (chunk) => reader.push(chunk),
      onExit: (info) => {
        reader.flush()
        transport.close()
        server.close(finishClose)
        // Force lingering keep-alive sockets closed so finishClose fires promptly.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        if (onChildExit) onChildExit(info)
      },
      onSpawnError: (err) => {
        server.close()
        if (!closers.settled) reject(new UnavailableError({ code: err.code }))
      },
    })

    const applyCors = (req, res) => {
      const origin = req.headers.origin
      if (allowAnyOrigin) {
        res.setHeader('Access-Control-Allow-Origin', '*')
      } else if (typeof origin === 'string' && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Accept')
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')
    }

    server.on('request', async (req, res) => {
      // BEARER-BEFORE-ROUTE: the very first check, before CORS/routing/parsing.
      if (bearer !== undefined && !bearerMatches(readBearer(req), bearer)) {
        replyStatus(res, 401)
        return
      }

      applyCors(req, res)
      if (req.method === 'OPTIONS') {
        replyStatus(res, 204)
        return
      }

      const path = (req.url ?? '').split('?')[0]
      if (path !== MCP_PATH || !MCP_METHODS.has(req.method)) {
        replyStatus(res, 404)
        return
      }

      if (req.method === 'POST') {
        const body = await readBody(req, bodyCapBytes)
        if (body === BODY_ABORTED) return // socket is gone; no reply to write
        if (body === BODY_TOO_LARGE) {
          replyStatus(res, 413)
          return
        }
        const parsed = parseBody(body)
        if (parsed === MALFORMED) {
          replyStatus(res, 400)
          return
        }
        transport.handleRequest(req, res, parsed)
        return
      }

      transport.handleRequest(req, res)
    })

    server.on('error', (err) => {
      // Bind failures (EADDRINUSE/EACCES) arrive here before 'listening'.
      supervisor.kill() // never-orphan
      server.close()
      reject(new UnavailableError({ code: err.code }))
    })

    server.listen(port, host, () => {
      const actualPort = server.address().port
      const url = `http://${formatHostForUrl(host)}:${actualPort}${MCP_PATH}`
      logger.banner(url)

      resolve({
        url,
        kill: () => supervisor.kill(), // immediate SIGKILL — never-orphan backstop
        close: () =>
          new Promise((resolveOuter) => {
            closers.resolveClose = resolveOuter
            transport.close()
            supervisor.stop() // grace -> SIGKILL, never-orphan
            server.close(finishClose)
            // Force lingering keep-alive/stalled sockets closed so finishClose
            // fires promptly (server.close otherwise waits for them indefinitely).
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
          }),
      })
    })
  })
}

module.exports = {
  startMcpFace,
  bearerMatches,
  DEFAULT_BODY_CAP_BYTES,
  MCP_PATH,
  BODY_ABORTED,
}
