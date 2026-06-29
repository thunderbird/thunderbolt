/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Transparent stdio ↔ WebSocket bridge for ACP agents and MCP servers.
 *
 * Spawns a local JSON-RPC-over-stdio process and exposes it over a WebSocket so
 * the in-browser app can reach it as a `remote-acp` agent / remote MCP server.
 * The pump is framing-aware on both edges:
 *   - WS → stdin: every WebSocket frame is exactly one JSON-RPC object (the app
 *     sends `JSON.stringify(msg)` per frame), so we forward it verbatim plus the
 *     trailing newline that the ndjson stdio framing requires.
 *   - stdout → WS: the process emits newline-delimited JSON, so we split on
 *     newlines and send each complete object as its own WebSocket frame — what
 *     the app's transport expects (`JSON.parse(event.data)` once per message).
 *
 * Lifecycle is 1:1: each WebSocket connection spawns its own dedicated process;
 * closing the socket kills the process, and a process exit closes the socket.
 * ACP and MCP share this exact pump (both speak ndjson JSON-RPC over stdio).
 */

import type { ServerWebSocket, Subprocess } from 'bun'
import type { BridgeConfig } from '../agent/types.ts'

/** Per-connection state: the spawned process this socket is pumping. `null`
 *  only in the instant between upgrade and `open` (or after a spawn failure). */
type BridgeSocketData = {
  proc: Subprocess<'pipe', 'pipe', 'inherit'> | null
}

type BridgeSocket = ServerWebSocket<BridgeSocketData>

/** A bridged stdio subprocess: piped stdin/stdout, inherited stderr. Shared by
 *  the WebSocket and iroh transports, which pump it identically. */
export type BridgeProc = Subprocess<'pipe', 'pipe', 'inherit'>

/** One-shot decoder for the rare binary inbound frame. Safe to share: it's only
 *  ever called without `{ stream: true }`, so it holds no cross-call state. The
 *  stdout pump deliberately uses its own decoder (streaming state must not be
 *  shared across concurrent connections). */
const frameDecoder = new TextDecoder()

/**
 * Pump a process's newline-delimited-JSON stdout to the socket, one JSON object
 * per WebSocket frame. Resolves when stdout closes (the process exited or was
 * killed). A trailing object without a final newline is flushed at close.
 */
const pumpStdoutToSocket = async (proc: BridgeProc, ws: BridgeSocket): Promise<void> => {
  // Per-pump decoder: `{ stream: true }` retains partial-multibyte state, which
  // would corrupt other connections if shared. Each connection gets its own.
  const decoder = new TextDecoder()
  const reader = proc.stdout.getReader()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) ws.send(trimmed)
    }
  }
  buffer += decoder.decode()
  const trailing = buffer.trim()
  if (trailing) ws.send(trailing)
}

/** Spawn the bridged agent, returning `null` if the executable can't be found
 *  (the parser guarantees a non-empty command). Bun.spawn throws synchronously
 *  on ENOENT — catching it at this connection boundary keeps one bad command
 *  from killing the whole server, and surfaces the reason on the operator's
 *  stderr so the failure is loud rather than silent. */
export const spawnAgent = (command: readonly string[]): BridgeProc | null => {
  try {
    return Bun.spawn({ cmd: [...command], stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  } catch (err) {
    process.stderr.write(
      `thunderbolt bridge: failed to spawn '${command[0]}': ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return null
  }
}

/**
 * Start the bridge server: listen for WebSocket connections and pump each one
 * to its own freshly-spawned `config.command` process. Returns once the server
 * is listening; the live server keeps the process alive until interrupted.
 */
export const runBridge = async (config: BridgeConfig): Promise<void> => {
  const server = Bun.serve<BridgeSocketData>({
    // Loopback-only: this transport is unauthenticated, so it must not be
    // reachable from the LAN (Bun's default binds every interface). The G3
    // consumer is the app running on the same machine; authenticated remote
    // access is the separate iroh transport (G4).
    hostname: '127.0.0.1',
    port: config.port,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { proc: null } })) return undefined
      return new Response('thunderbolt bridge: WebSocket endpoint only\n', { status: 426 })
    },
    websocket: {
      open(ws) {
        const proc = spawnAgent(config.command)
        if (!proc) {
          ws.close(1011, `failed to spawn '${config.command[0]}'`)
          return
        }
        ws.data.proc = proc
        void (async () => {
          try {
            await pumpStdoutToSocket(proc, ws)
          } catch (err) {
            process.stderr.write(
              `thunderbolt bridge: stdout pump error: ${err instanceof Error ? err.message : String(err)}\n`,
            )
          }
        })()
        void (async () => {
          const code = await proc.exited
          // 1000 (normal) only on a clean exit; a non-zero/killed exit is an
          // abnormal close (1011) so the app surfaces it instead of seeing
          // a successful shutdown.
          ws.close(code === 0 ? 1000 : 1011, `agent exited (code ${code})`)
        })()
      },
      message(ws, message) {
        const proc = ws.data.proc
        if (!proc) return
        const text = typeof message === 'string' ? message : frameDecoder.decode(message)
        proc.stdin.write(text + '\n')
        proc.stdin.flush()
      },
      close(ws) {
        ws.data.proc?.kill()
      },
    },
  })

  // A signal stops the server with `closeActiveConnections`, which fires each
  // socket's `close` handler and so kills every spawned agent before exit.
  const shutdown = (): void => {
    server.stop(true)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Advertise the exact bound address (not `localhost`, which can resolve to
  // the IPv6 `::1` and miss this IPv4-only loopback bind).
  const url = `ws://127.0.0.1:${server.port}`
  process.stdout.write(
    `⚡ thunderbolt ${config.protocol} bridge (${config.transport}) listening on ${url}\n` +
      `   spawning per connection: ${config.command.join(' ')}\n` +
      `   set this as the agent URL in the app: ${url}\n`,
  )
}
