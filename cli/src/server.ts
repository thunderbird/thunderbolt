// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The ACP WebSocket face. Binds a ws WebSocketServer on host:port (default
// 127.0.0.1), spawns the child via superviseChild, and pumps
// child.stdout (NDJSON) -> WS and WS -> child.stdin with Origin-gating,
// single-client newest-wins, and pause/resume backpressure. Prints the
// `ws://127.0.0.1:PORT` banner to stderr once listening.

import type { AddressInfo } from 'node:net'
import type { WebSocket } from 'ws'
import { UnavailableError } from './errors'
import { buildOriginAllowlist, safeClassifyFrame } from './log'
import { createNdjsonReader, frameToWs, wsToFrame } from './relay'
import { superviseChild as defaultSuperviseChild } from './child'
import { formatHostForUrl, makeCloseLatch } from './util'
import type { StartBridge, WebSocketServerClass } from './types'

/** Pause child stdout once a socket buffers more than this many bytes. */
const HIGH_WATER = 1 << 20 // 1 MiB
/** Resume child stdout once the socket drains below this. */
const LOW_WATER = 1 << 18 // 256 KiB
/** Normal WS close code for a superseded/torn-down client. */
const CLOSE_NORMAL = 1000

/**
 * Start the ACP WebSocket face: bind, spawn the child, and bridge NDJSON stdio
 * to a single newest-wins WebSocket client with an Origin gate and backpressure.
 */
const startBridge: StartBridge = ({
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
  const WebSocketServer: WebSocketServerClass =
    deps.WebSocketServer ?? (require('ws') as typeof import('ws')).WebSocketServer
  const superviseChild = deps.superviseChild ?? defaultSuperviseChild
  const isOriginAllowed = buildOriginAllowlist({ allowOrigins, allowAnyOrigin })

  return new Promise((resolve, reject) => {
    const latch = makeCloseLatch()
    let client: WebSocket | null = null
    let paused = false

    const sendToClient = (line: string): void => {
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
        logger.warn('drop-child-frame', safeClassifyFrame(line))
      }
    })

    // Origin gate (default-on): ws calls verifyClient on every upgrade BEFORE a
    // socket is accepted, so a disallowed Origin is rejected with no socket.
    const wss = new WebSocketServer({
      host,
      port,
      verifyClient: ({ origin }: { origin?: string }) => isOriginAllowed(origin),
    })

    const finishClose = latch.finishClose

    const supervisor = superviseChild({
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
        if (!latch.settled()) reject(new UnavailableError({ code: err.code }))
      },
    })

    wss.on('error', (err: NodeJS.ErrnoException) => {
      // Bind failures (EADDRINUSE/EACCES) arrive here before 'listening'.
      supervisor.kill() // never-orphan
      wss.close()
      reject(new UnavailableError({ code: err.code }))
    })

    wss.on('connection', (ws: WebSocket) => {
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

      ws.on('message', (data: Buffer) => {
        const raw = typeof data === 'string' ? data : data.toString('utf8')

        const frame = (() => {
          try {
            return wsToFrame(raw)
          } catch {
            return null
          }
        })()
        if (frame === null) {
          logger.warn('drop-ws-frame', safeClassifyFrame(raw))
          return
        }

        // Child stdin backpressure: writeStdin returns false when the pipe is
        // full — stop reading WS until the child stdin drains.
        if (supervisor.writeStdin(frame) === false) {
          ws.pause()
          supervisor.child.stdin!.once('drain', () => ws.resume())
        }
      })

      ws.on('close', () => {
        if (client === ws) client = null
      })
    })

    wss.on('listening', () => {
      const actualPort = (wss.address() as AddressInfo).port
      const url = `ws://${formatHostForUrl(host)}:${actualPort}`
      logger.banner(url)

      resolve({
        url,
        kill: () => supervisor.kill(), // immediate SIGKILL — never-orphan backstop
        close: () =>
          new Promise((resolveOuter) => {
            // If the child already exited the latch is settled and setResolver
            // resolves synchronously; otherwise the resolver fires on finishClose.
            latch.setResolver(resolveOuter)
            if (client) client.close(CLOSE_NORMAL)
            supervisor.stop() // grace -> SIGKILL (idempotent once gone), never-orphan
            wss.close(finishClose)
          }),
      })
    })
  })
}

export { startBridge, HIGH_WATER, LOW_WATER, CLOSE_NORMAL }
