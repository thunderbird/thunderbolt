/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Lifecycle wiring for thunderbolt-acp-bridge: spawn the agent, stand up a localhost
 * WebSocket server, connect them through the pure relay, and manage shutdown.
 *
 * Design constraints honored here:
 *   - Single persistent child reused across ws reconnects (Thunderbolt
 *     reconnects up to 3x; a per-connection child would lose session state).
 *   - stdio ['pipe','pipe','inherit'] — the agent's own stderr passes through
 *     untouched to the user's terminal (PII-safe: we never parse or log it).
 *   - error handlers everywhere (ENOENT, EADDRINUSE, EPIPE) so Node never
 *     crashes with an unhandled 'error'.
 *   - Ready banner only after the server is listening AND the child has
 *     survived the grace window.
 *   - SIGINT/SIGTERM → close ws 1000 + SIGTERM the child, escalating to SIGKILL.
 *   - child exit → close ws 1011 + exit.
 *
 * Dependencies (spawn, WebSocketServer, readline factory, clock) are injected so
 * the lifecycle can be exercised with fakes.
 */

import { exitCodes, spawnError, serverError, earlyExitError } from './errors.js'
import { wireAgentToWs, handleWsMessage } from './relay.js'
import { extractLogEvent, sanitizeOrigin, isOriginAllowed, defaultAllowedOrigins } from './log.js'

const GRACE_MS = 750
const KILL_ESCALATION_MS = 2000
const WS_OPEN = 1
const WS_CLOSE_POLICY_VIOLATION = 1008

/**
 * Start the bridge. Resolves once the ready banner has been emitted (server
 * listening + child survived grace). Rejects on a fatal startup error after
 * printing an actionable message and setting the exit code.
 *
 * @param {object} cfg
 * @param {string[]} cfg.agentCmd - [command, ...args]
 * @param {string} cfg.host
 * @param {number} cfg.port - 0 = ephemeral
 * @param {string[]} [cfg.allowOrigins] - extra Origins to accept (beyond the Thunderbolt defaults)
 * @param {boolean} [cfg.allowAnyOrigin] - disable the Origin check entirely (loud escape hatch)
 * @param {ReturnType<import('./log.js').createLogger>} cfg.logger
 * @param {object} deps
 * @param {typeof import('node:child_process').spawn} deps.spawn
 * @param {new (opts: object) => import('ws').WebSocketServer} deps.WebSocketServer
 * @param {(stream: NodeJS.ReadableStream) => import('node:events').EventEmitter} deps.createLineReader
 * @param {(label: string) => void} [deps.onBanner] - prints the ready banner
 * @param {(stop: (reason: string, code: number) => void) => void} [deps.onStop] - receives the stop fn synchronously (before grace resolves)
 * @param {(code: number) => void} [deps.exit] - process.exit (injectable)
 * @returns {Promise<{ stop: (reason: string, code: number) => void }>}
 */
export const startBridge = async (cfg, deps) => {
  const { agentCmd, host, port, logger, allowOrigins = [], allowAnyOrigin = false } = cfg
  const { spawn, WebSocketServer, createLineReader, onBanner, exit = process.exit } = deps

  const cmd0 = agentCmd[0]
  const allowlist = [...defaultAllowedOrigins, ...allowOrigins]

  if (allowAnyOrigin) {
    logger.warn({ lifecycle: 'origin-check-disabled' })
    process.stderr.write(
      '\nWARNING: --allow-any-origin is set — the Origin check is OFF.\n' +
        'Any web page open in a browser on this machine can connect to the bridge\n' +
        'and drive your agent. Use this only for trusted dev/self-host setups.\n',
    )
  }

  if (!isLoopbackHost(host)) {
    process.stderr.write(
      `\nWARNING: --host ${host} is not a loopback address — the bridge (and your\n` +
        'agent) is now reachable by other hosts on the network, not just this\n' +
        'machine. Keep the default 127.0.0.1 unless you really need remote access.\n',
    )
  }

  const child = spawn(cmd0, agentCmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })

  /** @type {import('ws').WebSocketServer | null} */
  let wss = null
  /** @type {import('ws').WebSocket | null} */
  let activeSocket = null
  let readerPaused = false
  let shuttingDown = false
  let ready = false
  let exited = false

  // One-shot final exit. After a signal-driven stop, the actual exit is deferred
  // to the child's 'exit' event (or the SIGKILL fallback timer), so guard it.
  const finalExit = (code) => {
    if (exited) return
    exited = true
    exit(code)
  }

  const safeExit = (code) => {
    if (shuttingDown) return
    shuttingDown = true
    // Never orphan the agent: if the child outlived a fatal error (e.g. the ws
    // server failed to bind), kill it before we exit. safeExit is the only fatal
    // chokepoint; the signal path uses stop(), so this never double-kills.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    finalExit(code)
  }

  // --- agent stdout → ws (single persistent reader, reused across reconnects) ---
  const lines = createLineReader(child.stdout)
  wireAgentToWs({
    lines,
    send: (line) => {
      if (activeSocket && activeSocket.readyState === WS_OPEN) activeSocket.send(line)
    },
    onForward: (line) =>
      logger.debug(extractLogEvent({ direction: 'agent->ws', line })),
    // A dropped line is a raw, non-JSON stdout line that may contain content.
    // Extract ONLY its byte length here — the line text is never logged.
    onDrop: (line) =>
      logger.warn({ lifecycle: 'dropped-non-json', byteSize: Buffer.byteLength(line) }),
  })

  child.stdin.on('error', (err) => {
    // EPIPE when the agent closed stdin — log lifecycle, don't crash.
    logger.warn({ lifecycle: 'stdin-error', errorCode: err.code })
  })

  child.stdout.on('error', (err) => {
    // An unhandled stdout 'error' would crash Node — log the code only (PII-safe).
    logger.warn({ lifecycle: 'stdout-error', errorCode: err.code })
  })

  return new Promise((resolve, reject) => {
    const closeWebSocket = (code) => {
      if (activeSocket && activeSocket.readyState === WS_OPEN) activeSocket.close(code)
      wss?.close()
    }

    // While no client is connected, pause the agent→ws relay so the agent's output
    // (e.g. an in-flight response during a client reconnect) is held by OS pipe
    // backpressure instead of dropped. Resumed on the next connection.
    const clearActiveSocket = (socket) => {
      if (activeSocket !== socket) return
      activeSocket = null
      if (!readerPaused) {
        lines.pause()
        readerPaused = true
      }
    }

    // The exit code a signal-driven stop should ultimately exit with. The child's
    // 'exit' handler reads it so the actual process.exit happens only once the
    // child has died (or the SIGKILL fallback fires).
    let stopCode = null
    /** @type {ReturnType<typeof setTimeout> | null} */
    let killTimer = null

    /**
     * Stop the bridge on a signal: close the ws, SIGTERM the child, and DEFER the
     * final exit — let the child's 'exit' handler drive it once the agent dies.
     * A REF'd fallback timer escalates to SIGKILL (and forces exit) if a stubborn
     * agent ignores SIGTERM, so it can never be orphaned.
     * @param {string} reason
     * @param {number} code
     */
    const stop = (reason, code) => {
      if (shuttingDown) return
      shuttingDown = true
      stopCode = code
      logger.info({ lifecycle: 'stopping', reason })
      closeWebSocket(1000)
      process.stderr.write('\nStopping…\n')

      // Already dead? Exit straight away.
      if (child.exitCode !== null || child.signalCode !== null) {
        finalExit(code)
        return
      }

      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        logger.warn({ lifecycle: 'kill-escalation' })
        child.kill('SIGKILL')
        finalExit(code)
      }, KILL_ESCALATION_MS)
    }

    // --- child error / early-exit handling -----------------------------------
    child.on('error', (err) => {
      const { message, exitCode } = spawnError(err, { cmd0 })
      logger.error({ lifecycle: 'spawn-failed', errorCode: err.code })
      process.stderr.write(`\n${message}\n`)
      closeWebSocket(1011)
      reject(Object.assign(new Error(message), { exitCode }))
      safeExit(exitCode)
    })

    // Registered synchronously in the same tick as spawn() above (nothing awaits
    // before this Promise) and a child 'exit' is always delivered asynchronously,
    // so this listener can never miss it. That invariant is what makes the grace
    // timer's `exitCode !== null` early-return safe — by the time exitCode is set,
    // this handler has already settled the Promise. Do NOT add an `await` before
    // this Promise: it would open a window where the child exits unobserved.
    child.on('exit', (code, signal) => {
      // A signal-driven stop is in progress: the child has now died, so clear the
      // SIGKILL fallback and drive the deferred final exit.
      if (shuttingDown) {
        if (killTimer) clearTimeout(killTimer)
        logger.info({ lifecycle: 'agent-exited', exitCode: code ?? undefined, signal: signal ?? undefined })
        process.stderr.write('\nStopped.\n')
        finalExit(stopCode ?? exitCodes.ok)
        return
      }
      if (!ready) {
        const { message, exitCode } = earlyExitError({ code, signal, cmd0 })
        logger.error({ lifecycle: 'agent-early-exit', exitCode: code ?? undefined, signal: signal ?? undefined })
        process.stderr.write(`\n${message}\n`)
        process.stderr.write('(the agent\'s own output above may say why)\n')
        closeWebSocket(1011)
        reject(Object.assign(new Error(message), { exitCode }))
        safeExit(exitCode)
        return
      }
      logger.info({ lifecycle: 'agent-exited', exitCode: code ?? undefined, signal: signal ?? undefined })
      process.stderr.write('\nAgent exited. Stopping bridge.\n')
      closeWebSocket(1011)
      safeExit(code === 0 ? exitCodes.ok : exitCodes.unavailable)
    })

    // --- WebSocket server -----------------------------------------------------
    // verifyClient runs DURING the upgrade handshake: a disallowed Origin is
    // rejected with HTTP 403 and the WebSocket is never established, so a hostile
    // web page can't even briefly connect. The 'connection' handler below repeats
    // the check as deterministic defense-in-depth (closing with 1008) for any
    // path that bypasses verifyClient.
    const verifyClient = ({ origin }) =>
      allowAnyOrigin || isOriginAllowed(origin, allowlist)
    wss = new WebSocketServer({ host, port, verifyClient })

    wss.on('error', (err) => {
      const { message, exitCode } = serverError(err, { host, port })
      logger.error({ lifecycle: 'server-error', errorCode: err.code })
      process.stderr.write(`\n${message}\n`)
      reject(Object.assign(new Error(message), { exitCode }))
      safeExit(exitCode)
    })

    wss.on('connection', (socket, request) => {
      const rawOrigin = request?.headers?.origin
      const origin = sanitizeOrigin(rawOrigin)

      // Browser WebSocket connections aren't same-origin-protected: reject any
      // Origin that isn't a known Thunderbolt app origin so a random web page on
      // this machine can't hijack the local agent. The origin string is PII-safe
      // to log (sanitized to scheme + host).
      if (!allowAnyOrigin && !isOriginAllowed(rawOrigin, allowlist)) {
        logger.warn({ lifecycle: 'origin-rejected', origin })
        socket.close(WS_CLOSE_POLICY_VIOLATION)
        return
      }

      logger.info({ lifecycle: 'connected', origin })
      // Single-client bridge: a new connection supersedes any previous one. Assign
      // the new socket first (so the old socket's 'close' handler won't null it),
      // then close the old one so a superseded client can't keep injecting into the
      // shared agent stdin while only the newest receives output.
      const previous = activeSocket
      activeSocket = socket
      if (previous && previous !== socket && previous.readyState === WS_OPEN) previous.close(1000)
      if (readerPaused) {
        lines.resume()
        readerPaused = false
      }

      socket.on('message', (data) => {
        // Drop messages from a socket that's been superseded by a newer connection:
        // close() doesn't synchronously stop buffered 'message' events, so guard on
        // identity to keep a stale client out of the shared agent stdin.
        if (activeSocket !== socket) return
        handleWsMessage({
          data,
          write: (chunk) => child.stdin.write(chunk),
          onWrite: (chunk) =>
            logger.debug(extractLogEvent({ direction: 'ws->agent', line: chunk.replace(/\n$/, '') })),
        })
      })
      socket.on('error', (err) => {
        logger.warn({ lifecycle: 'socket-error', errorCode: err.code })
        clearActiveSocket(socket)
      })
      socket.on('close', (closeCode) => {
        clearActiveSocket(socket)
        logger.info({ lifecycle: 'disconnected', closeCode })
      })
    })

    wss.on('listening', () => {
      const resolvedPort = resolvePort(wss, port)
      logger.info({ lifecycle: 'listening', port: resolvedPort })
      // Banner only after the child also survives the grace window.
      setTimeout(() => {
        if (shuttingDown) return
        if (child.exitCode !== null || child.signalCode !== null) return // exit handler already fired
        ready = true
        // Bracket an IPv6 literal host (the only host form with a colon) per RFC 3986,
        // unless the user already passed it bracketed — avoid ws://[[::1]]:PORT.
        const hostForUrl = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
        onBanner?.(`ws://${hostForUrl}:${resolvedPort}`)
        resolve({ stop })
      }, GRACE_MS)
    })

    deps.onStop?.(stop)
  })
}

/**
 * Whether a bind host is a loopback address (only reachable from this machine).
 * A non-loopback host exposes the agent to other hosts on the network, which
 * warrants a prominent startup warning.
 * @param {string} host
 * @returns {boolean}
 */
const isLoopbackHost = (host) =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1'

/**
 * Resolve the actual listening port (ephemeral 0 → OS-assigned).
 * @param {import('ws').WebSocketServer | null} wss
 * @param {number} requested
 * @returns {number}
 */
const resolvePort = (wss, requested) => {
  const address = wss?.address?.()
  if (address && typeof address === 'object' && typeof address.port === 'number') {
    return address.port
  }
  return requested
}
