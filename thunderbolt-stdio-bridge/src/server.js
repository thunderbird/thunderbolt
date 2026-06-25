// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The ACP WebSocket face. Binds a ws WebSocketServer on host:port (default
// 127.0.0.1), spawns the child via superviseChild, and pumps
// child.stdout (NDJSON) -> WS and WS -> child.stdin with Origin-gating,
// single-client newest-wins, and pause/resume backpressure. Prints the
// `ws://127.0.0.1:PORT` banner to stderr once listening.

'use strict'

const { UnavailableError } = require('./errors')
const { buildOriginAllowlist, classifyMethod, classifyId } = require('./log')
const { createNdjsonReader, frameToWs, wsToFrame } = require('./relay')
const { superviseChild: defaultSuperviseChild } = require('./child')
const { formatHostForUrl } = require('./util')

/** Pause child stdout once a socket buffers more than this many bytes. */
const HIGH_WATER = 1 << 20 // 1 MiB
/** Resume child stdout once the socket drains below this. */
const LOW_WATER = 1 << 18 // 256 KiB
/** Normal WS close code for a superseded/torn-down client. */
const CLOSE_NORMAL = 1000

/** PII-safe classification of a raw frame; never throws and never returns body. */
const safeClassify = (raw) => {
  try {
    const frame = JSON.parse(raw)
    return { method: classifyMethod(frame), id: classifyId(frame) }
  } catch {
    return { method: 'unknown', id: 'absent' }
  }
}

/**
 * Start the ACP WebSocket face: bind, spawn the child, and bridge NDJSON stdio
 * to a single newest-wins WebSocket client with an Origin gate and backpressure.
 *
 * @param {Object} opts
 * @param {string[]} opts.launch - child launch argv.
 * @param {string} opts.host
 * @param {number} opts.port - 0 => OS-assigned ephemeral.
 * @param {string[]} opts.allowOrigins
 * @param {boolean} opts.allowAnyOrigin
 * @param {Object} opts.logger
 * @param {(info: {code: number|null, signal: string|null}) => void} [opts.onChildExit]
 *   - notified when the child exits so the caller can derive its exit code.
 * @param {Object} [opts.deps] - injectable { WebSocketServer, spawn, superviseChild }.
 * @returns {Promise<{ url: string, kill(): void, close(): Promise<void> }>}
 */
const startBridge = ({
  launch,
  host,
  port,
  allowOrigins,
  allowAnyOrigin,
  logger,
  onChildExit,
  deps = {},
}) => {
  // The real ws dep is resolved lazily so fully-faked unit tests never load it.
  const WebSocketServer = deps.WebSocketServer ?? require('ws').WebSocketServer
  const superviseChild = deps.superviseChild ?? defaultSuperviseChild
  const isOriginAllowed = buildOriginAllowlist({ allowOrigins, allowAnyOrigin })

  return new Promise((resolve, reject) => {
    const closers = { resolveClose: null, settled: false }
    let client = null
    let supervisor = null
    let paused = false

    const sendToClient = (line) => {
      if (!client || client.readyState !== client.OPEN) return
      const payload = frameToWs(line)
      // The send callback fires once this frame has flushed to the socket; use it
      // to lift backpressure event-driven (no polling timer).
      client.send(payload, () => {
        if (paused && client && client.bufferedAmount < LOW_WATER) {
          paused = false
          supervisor.resumeStdout()
        }
      })
      if (client.bufferedAmount > HIGH_WATER && !paused) {
        paused = true
        supervisor.pauseStdout()
      }
    }

    // child.stdout NDJSON -> WS, dropping malformed lines (logged by method/id).
    const reader = createNdjsonReader((line) => {
      try {
        sendToClient(line)
      } catch {
        logger.warn('drop-child-frame', safeClassify(line))
      }
    })

    // Origin gate (default-on): ws calls verifyClient on every upgrade BEFORE a
    // socket is accepted, so a disallowed Origin is rejected with no socket.
    const wss = new WebSocketServer({
      host,
      port,
      verifyClient: ({ origin }) => isOriginAllowed(origin),
    })

    const finishClose = () => {
      if (closers.settled) return
      closers.settled = true
      if (closers.resolveClose) closers.resolveClose()
    }

    supervisor = superviseChild({
      launch,
      spawn: deps.spawn,
      logger,
      onStdout: (chunk) => reader.push(chunk),
      onExit: (info) => {
        reader.flush()
        if (client) client.close(CLOSE_NORMAL)
        wss.close(finishClose)
        if (onChildExit) onChildExit(info)
      },
      onSpawnError: (err) => {
        // Spawn ENOENT etc. — tear the server down and surface as unavailable.
        wss.close()
        if (!closers.settled) reject(new UnavailableError({ code: err.code }))
      },
    })

    wss.on('error', (err) => {
      // Bind failures (EADDRINUSE/EACCES) arrive here before 'listening'.
      supervisor.kill() // never-orphan
      wss.close()
      reject(new UnavailableError({ code: err.code }))
    })

    wss.on('connection', (ws) => {
      // newest-wins: a new client supersedes the prior one (closed 1000).
      if (client && client.readyState === client.OPEN) {
        client.close(CLOSE_NORMAL)
      }
      client = ws
      if (paused) {
        // The prior client congested and physically paused child.stdout; the new
        // client must not inherit a wedged stream.
        paused = false
        supervisor.resumeStdout()
      }

      ws.on('message', (data) => {
        const raw = typeof data === 'string' ? data : data.toString('utf8')

        const frame = (() => {
          try {
            return wsToFrame(raw)
          } catch {
            return null
          }
        })()
        if (frame === null) {
          logger.warn('drop-ws-frame', safeClassify(raw))
          return
        }

        // Child stdin backpressure: writeStdin returns false when the pipe is
        // full — stop reading WS until the child stdin drains.
        if (supervisor.writeStdin(frame) === false) {
          ws.pause()
          supervisor.child.stdin.once('drain', () => ws.resume())
        }
      })

      ws.on('close', () => {
        if (client === ws) client = null
      })
    })

    wss.on('listening', () => {
      const actualPort = wss.address().port
      const url = `ws://${formatHostForUrl(host)}:${actualPort}`
      logger.banner(url)

      resolve({
        url,
        kill: () => supervisor.kill(), // immediate SIGKILL — never-orphan backstop
        close: () =>
          new Promise((resolveOuter) => {
            // Already torn down (e.g. child exited first): resolve immediately.
            if (closers.settled) {
              supervisor.stop() // idempotent no-op once the child is gone
              resolveOuter()
              return
            }
            closers.resolveClose = resolveOuter
            if (client) client.close(CLOSE_NORMAL)
            supervisor.stop() // grace -> SIGKILL, never-orphan
            wss.close(finishClose)
          }),
      })
    })
  })
}

module.exports = { startBridge, HIGH_WATER, LOW_WATER, CLOSE_NORMAL }
