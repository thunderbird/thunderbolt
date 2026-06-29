// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The MCP Streamable HTTP face. Stands up a minimal http.createServer on
// host:port (default 127.0.0.1) and bridges many HTTP MCP clients onto the ONE
// spawned stdio MCP child.
//
// MULTIPLEXING. A StreamableHTTPServerTransport is STATEFUL and single-session:
// the SDK rejects a second `initialize` POST with -32600 "Server already
// initialized" before onmessage ever fires (see webStandardStreamableHttp.js).
// The Thunderbolt app opens several MCP connections (a Test-Connection probe,
// the persistent provider connection, reconnects), so one shared transport kills
// every connection after the first. The fix: one STATELESS transport per HTTP
// request (the SDK forbids reusing a stateless transport across requests) plus a
// bridge-owned multiplexer that (a) forwards the FIRST initialize to the child,
// captures its result, and answers every later client initialize FROM CACHE
// without touching the child (the child — server-everything — rejects a second
// initialize too); (b) remaps each client request id to a process-global id so
// concurrent clients' colliding ids route back to the right transport; (c)
// forwards `notifications/initialized` exactly once; (d) broadcasts the child's
// id-less notifications to every live transport.
//
// Enforces bearer-before-route, CORS per the Origin allowlist, a request body
// cap, and deterministic never-orphan teardown. Prints the
// `http://127.0.0.1:PORT/mcp` banner to stderr once listening.

import { createServer as defaultCreateServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport as DefaultStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { UnavailableError } from './errors'
import { buildOriginAllowlist, safeClassifyFrame } from './log'
import { createNdjsonReader } from './relay'
import { createMultiplexer } from './mcp-multiplexer'
import { superviseChild as defaultSuperviseChild } from './child'
import { formatHostForUrl, makeCloseLatch } from './util'
import type { ChildExit, JsonRpcMessage, McpTransport, McpTransportClass, StartMcpFace } from './types'

/** Default request body cap: 4 MiB. Larger POST bodies are rejected with 413. */
const DEFAULT_BODY_CAP_BYTES = 4 << 20
/** The single MCP endpoint path the face serves. */
const MCP_PATH = '/mcp'
/** Methods the transport handles on /mcp. Everything else is 404. */
const MCP_METHODS = new Set(['POST', 'GET', 'DELETE'])

/** SHA-256 digest a string to a fixed 32-byte buffer. */
const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/**
 * Constant-time bearer comparison that never leaks length. The provided token is
 * SHA-256 digested to a fixed 32-byte buffer and compared against the expected
 * token's pre-computed digest (also 32 bytes), so unequal input lengths can
 * never throw or short-circuit. The expected digest is hashed once per process
 * (the bearer is fixed) rather than per request.
 */
const bearerMatches = (provided: string | undefined, expectedDigest: Buffer): boolean => {
  if (typeof provided !== 'string') return false
  return timingSafeEqual(sha256(provided), expectedDigest)
}

/** Extract the `Bearer <token>` value from an Authorization header, or undefined. */
const readBearer = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer (.+)$/.exec(header)
  return match ? match[1] : undefined
}

/** Reply with a status code and no body leak. */
const replyStatus = (res: ServerResponse, status: number): void => {
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
 */
const parseBody = (body: string): unknown => {
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
 */
const readBody = (req: IncomingMessage, cap: number): Promise<string | typeof BODY_TOO_LARGE | typeof BODY_ABORTED> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflowed = false
    let settled = false
    const settle = (value: string | typeof BODY_TOO_LARGE | typeof BODY_ABORTED): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
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
 * and multiplex many HTTP MCP clients onto the single child's NDJSON stdio.
 * Bearer-before-route, CORS, body cap, deterministic teardown, never-orphan.
 */
const startMcpFace: StartMcpFace = ({
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
  // Adapt the SDK transport to the bridge's structural McpTransportClass. A single
  // `as` (not `as unknown as`) keeps the conversion checked: it requires the SDK
  // class to still structurally overlap the stateless-constructor + handleRequest/
  // send/close/onmessage shape the mux drives, so constructor or method drift in a
  // future SDK surfaces here at compile time instead of silently at runtime.
  const StreamableHTTPServerTransport =
    deps.StreamableHTTPServerTransport ?? (DefaultStreamableHTTPServerTransport as McpTransportClass)
  const superviseChild = deps.superviseChild ?? defaultSuperviseChild
  const isOriginAllowed = buildOriginAllowlist({ allowOrigins, allowAnyOrigin })

  // The bearer is fixed for the process, so digest the expected value once here
  // rather than per request; each request only digests the provided token.
  const expectedDigest = bearer !== undefined ? sha256(bearer) : undefined

  return new Promise((resolve, reject) => {
    const latch = makeCloseLatch()

    // The start promise settles exactly once. `listen` success resolves a live
    // face; a spawn/bind error rejects. This once-guard makes whichever fires
    // first win so the loser is a no-op — `latch.settled()` only tracks the CLOSE
    // lifecycle, so without it a spawn error that lands just AFTER the listen
    // callback resolved would tear the http server down under an already-resolved
    // face (and silently skip onChildExit), leaving the caller holding a live
    // handle pointing at a dead child. See reapChild + onSpawnError below.
    let startSettled = false

    // The bridge-owned multiplexer: owns the single child's initialize cache, the
    // global request-id remap, and the live-transport registry. `writeChild`
    // reads `supervisor` lazily — it's declared below but always assigned before
    // any frame can flow (the first child write happens on an HTTP request, long
    // after this synchronous setup completes).
    const mux = createMultiplexer({
      writeChild: (frame) => supervisor.writeStdin(frame),
      logger,
    })

    // child stdout NDJSON -> HTTP: each complete line is parsed and routed by the
    // multiplexer to the transport that owns its id (or, for the captured init
    // result, to every queued initialize; for id-less notifications, broadcast to
    // every live transport). A malformed line is dropped + logged PII-safe.
    const reader = createNdjsonReader((line) => {
      const message = (() => {
        try {
          return JSON.parse(line) as JsonRpcMessage
        } catch {
          logger.warn('drop-child-frame', safeClassifyFrame(line))
          return null
        }
      })()
      if (message) mux.onChildMessage(message)
    })

    const server = createServer()

    const finishClose = latch.finishClose

    // Close every live transport then the http server, settling the close latch
    // once the server's callback fires. Lingering keep-alive/stalled sockets are
    // force-closed so finishClose fires promptly (server.close otherwise waits
    // indefinitely). Shared by child-exit teardown and the resolved close().
    const shutdownHttp = () => {
      mux.closeAll()
      server.close(finishClose)
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    }

    // Flush the child's stdout, tear the http server down, and notify the caller.
    // Shared by a normal self-exit and by a spawn error that lands AFTER the face
    // already resolved, so a resolved face never silently points at a dead child.
    const reapChild = (info: ChildExit): void => {
      reader.flush()
      shutdownHttp()
      if (onChildExit) onChildExit(info)
    }

    const supervisor = superviseChild({
      launch,
      spawn: deps.spawn,
      logger,
      onStdout: (chunk) => reader.push(chunk),
      onExit: reapChild,
      onSpawnError: (err) => {
        // A spawn failure (ENOENT/EACCES): the child never produced a usable face.
        // If listen already won the race and resolved the start promise, reap like
        // a self-exit so the caller learns the child is dead and nothing is
        // orphaned; otherwise this is the first settle, so reject.
        if (startSettled) {
          reapChild({ code: null, signal: null })
          return
        }
        startSettled = true
        server.close()
        reject(new UnavailableError({ code: err.code }))
      },
    })

    const applyCors = (req: IncomingMessage, res: ServerResponse): void => {
      const origin = req.headers.origin
      if (allowAnyOrigin) {
        res.setHeader('Access-Control-Allow-Origin', '*')
      } else if (typeof origin === 'string' && isOriginAllowed(origin)) {
        // Reflect the request Origin ONLY after the isOriginAllowed() allowlist gate
        // (loopback + explicit --allow-origin); an arbitrary origin gets no ACAO header —
        // the correct credentialed-CORS pattern. Bare trailing nosemgrep on the matched line
        // (the rule-id form did not suppress the registry cors-misconfiguration rule).
        res.setHeader('Access-Control-Allow-Origin', origin) // nosemgrep
        res.setHeader('Vary', 'Origin')
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      // MCP Streamable HTTP clients send `Mcp-Protocol-Version` on every request
      // after initialize; it must be allow-listed or the browser's preflight fails.
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept',
      )
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')
    }

    // Hand a request to a fresh per-request transport, swallowing a benign
    // rejection (a client that disconnected mid-response). The SDK can reject from
    // handleRequest the same way it can from send; a stale client is not a fatal
    // bridge fault, so it must never reach the never-orphan backstop. Reply 500
    // only if the socket is still writable; otherwise the response is already gone
    // — just drop. The caller-supplied thunk runs handleRequest with the right
    // arity (the POST path always passes its parsed body, possibly undefined;
    // GET/DELETE pass none). The transport is registered for the lifetime of the
    // request and unregistered once handleRequest settles.
    const dispatch = (res: ServerResponse, makeHandle: (transport: McpTransport) => Promise<void>): void => {
      const transport = mux.createTransport(StreamableHTTPServerTransport)
      Promise.resolve(makeHandle(transport))
        .catch((err: NodeJS.ErrnoException) => {
          logger.warn('drop-http-frame', { errorCode: err && err.code })
          if (res.writable && !res.writableEnded && !res.headersSent) replyStatus(res, 500)
        })
        .finally(() => mux.releaseTransport(transport))
    }

    server.on('request', async (req, res) => {
      // BEARER-BEFORE-ROUTE: the very first check, before the Origin gate, CORS,
      // routing, or parsing.
      if (expectedDigest !== undefined && !bearerMatches(readBearer(req), expectedDigest)) {
        replyStatus(res, 401)
        return
      }

      // ORIGIN GATE (server-side, default-on): mirror the ACP face's hard reject.
      // A cross-origin *simple* POST (text/plain JSON-RPC body) is not preflighted,
      // so withholding the ACAO header alone does NOT stop the request from
      // executing — CORS only blocks the page from reading the response, not from
      // sending it. In the default no-bearer local mode that is a CSRF hole, so a
      // PRESENT, disallowed Origin is rejected 403 before any routing. An ABSENT
      // Origin is allowed (non-browser clients legitimately send none); when
      // --allow-any-origin is set isOriginAllowed returns true and this is a no-op.
      const origin = req.headers.origin
      if (typeof origin === 'string' && !isOriginAllowed(origin)) {
        replyStatus(res, 403)
        return
      }

      applyCors(req, res)
      if (req.method === 'OPTIONS') {
        replyStatus(res, 204)
        return
      }

      const path = (req.url ?? '').split('?')[0]
      if (path !== MCP_PATH || !MCP_METHODS.has(req.method!)) {
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
        dispatch(res, (transport) => transport.handleRequest(req, res, parsed))
        return
      }

      dispatch(res, (transport) => transport.handleRequest(req, res))
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      // Bind failures (EADDRINUSE/EACCES) arrive here before 'listening'.
      supervisor.kill() // never-orphan
      server.close()
      reject(new UnavailableError({ code: err.code }))
    })

    server.listen(port, host, () => {
      // If a spawn/bind error already rejected (won the race), the http server is
      // being torn down — resolving now would hand back a dead face (and print a
      // spurious banner), so this callback is a no-op once the start has settled.
      if (startSettled) return
      startSettled = true
      const actualPort = (server.address() as AddressInfo).port
      const url = `http://${formatHostForUrl(host)}:${actualPort}${MCP_PATH}`
      logger.banner(url)

      resolve({
        url,
        kill: () => supervisor.kill(), // immediate SIGKILL — never-orphan backstop
        close: () =>
          new Promise((resolveOuter) => {
            latch.setResolver(resolveOuter)
            supervisor.stop() // grace -> SIGKILL, never-orphan
            shutdownHttp()
          }),
      })
    })
  })
}

export { startMcpFace, bearerMatches }
