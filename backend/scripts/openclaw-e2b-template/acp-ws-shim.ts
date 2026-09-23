/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * OpenClaw ⇄ Thunderbolt ACP bridge — POC spike.
 *
 * Thunderbolt connects to a `remote-acp` agent over a WebSocket, framing one
 * JSON-RPC object per WS message (see src/acp/transports/websocket.ts). OpenClaw
 * exposes an ACP agent over *stdio* via `openclaw acp`, using newline-delimited
 * JSON. This shim is the ~framing adapter~ between the two — nothing more:
 *
 *   inbound  WS message  ──►  child.stdin   (append "\n")
 *   child.stdout line    ──►  outbound WS   (strip "\n", one object per message)
 *
 * It never parses or interprets ACP; it only translates the transport framing,
 * so it survives OpenClaw/ACP version drift. Each WS connection spawns a fresh
 * `openclaw acp` child and kills it on close.
 *
 * Run:   bun spikes/openclaw-acp-poc/acp-ws-shim.ts
 * Then:  add  ws://localhost:8790  as a custom agent in the Tauri desktop app
 *        (Settings → Agents → Add) with the proxy toggle OFF (Standalone).
 *
 * Env:
 *   PORT              WS port to listen on            (default 8790)
 *   OPENCLAW_BIN      openclaw executable             (default "openclaw")
 *   OPENCLAW_ACP_ARGS extra args for `openclaw acp`   (e.g. "--url wss://host:18789 --token abc")
 */

import type { ServerWebSocket, Subprocess } from 'bun'

const PORT = Number(process.env.PORT ?? 8790)
const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? 'openclaw'
const ACP_ARGS = (process.env.OPENCLAW_ACP_ARGS ?? '').split(' ').filter(Boolean)

type Session = {
  child: Subprocess<'pipe', 'pipe', 'inherit'>
  /** Partial stdout line carried across chunk boundaries. */
  buffer: string
}

/** Bun keys handlers by the socket instance, so a Map keyed on `ws` is stable. */
const sessions = new Map<ServerWebSocket<unknown>, Session>()

/** Read newline-delimited JSON from the child's stdout and forward each complete
 *  line as a discrete WS message (Thunderbolt does `JSON.parse(event.data)`). */
const pumpStdout = async (ws: ServerWebSocket<unknown>, session: Session): Promise<void> => {
  const decoder = new TextDecoder()
  for await (const chunk of session.child.stdout) {
    session.buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let nl = session.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = session.buffer.slice(0, nl).trim()
      session.buffer = session.buffer.slice(nl + 1)
      if (line.length > 0) {
        ws.send(line)
      }
      nl = session.buffer.indexOf('\n')
    }
  }
}

const startSession = (ws: ServerWebSocket<unknown>): void => {
  const child = Bun.spawn([OPENCLAW_BIN, 'acp', ...ACP_ARGS], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit', // surface openclaw's own logs in this terminal
    onExit(_proc, exitCode, signalCode) {
      console.error(`[shim] openclaw acp exited (code=${exitCode} signal=${signalCode})`)
      ws.close(1011, 'openclaw acp exited')
    },
  })
  const session: Session = { child, buffer: '' }
  sessions.set(ws, session)
  pumpStdout(ws, session).catch((err) => {
    console.error('[shim] stdout pump error:', err)
    ws.close(1011, 'stdout pump error')
  })
  console.error(`[shim] client connected → spawned "${[OPENCLAW_BIN, 'acp', ...ACP_ARGS].join(' ')}"`)
}

const endSession = (ws: ServerWebSocket<unknown>): void => {
  const session = sessions.get(ws)
  if (!session) {
    return
  }
  sessions.delete(ws)
  session.child.kill()
  console.error('[shim] client disconnected → killed openclaw acp')
}

const server = Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? '0.0.0.0',
  fetch(req, srv) {
    if (srv.upgrade(req)) {
      return undefined
    }
    return new Response('ACP WS shim — connect over WebSocket', { status: 426 })
  },
  websocket: {
    open(ws) {
      startSession(ws)
    },
    message(ws, message) {
      const session = sessions.get(ws)
      if (!session) {
        return
      }
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
      session.child.stdin.write(`${text}\n`)
      session.child.stdin.flush()
    },
    close(ws) {
      endSession(ws)
    },
  },
})

console.error(`[shim] listening on ws://localhost:${server.port}  (bridging → ${OPENCLAW_BIN} acp)`)
