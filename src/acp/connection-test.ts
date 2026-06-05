/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * One-shot connection probe for the "Add Custom Agent" settings dialog. Mirrors
 * the model "Test Connection" flow: open the raw endpoint, run the ACP
 * `initialize` handshake, and report success (with the agent's capabilities) or
 * a user-facing error.
 *
 * Unlike {@link connectAcpAdapter}, this opens the endpoint via
 * `openWebSocketTransport` *directly* — skipping the managed-ACP bearer /
 * subprotocol routing in `openTransport`. Remote custom agents carry their own
 * auth (or none), so the probe never needs a backend credential. The transport
 * is always torn down in a `finally`, even on timeout, so no socket leaks.
 */

import type { Agent as AcpSdkAgent, ClientSideConnection, Client } from '@agentclientprotocol/sdk'
import { ClientSideConnection as ClientSideConnectionImpl } from '@agentclientprotocol/sdk'
import type { AgentCapabilities } from '@/types/acp'
import { adaptCapabilities } from './acp-adapter'
import { openWebSocketTransport, type WebSocketFactory } from './transports/websocket'
import type { AcpTransport } from './types'

const protocolVersion = 1
const clientName = 'thunderbolt'
const clientVersion = '0.2.0'
const defaultTimeoutMs = 10000

/** Minimal client handler: the probe never drives a session, so session updates
 *  are dropped and any permission prompt is auto-cancelled (same cancelled shape
 *  the adapter uses as its safe default). */
const probeClient: Client = {
  sessionUpdate: async () => {},
  requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
}

type OpenWebSocketTransport = typeof openWebSocketTransport

type ClientSideConnectionCtor = new (
  toClient: (agent: AcpSdkAgent) => Client,
  stream: AcpTransport['stream'],
) => ClientSideConnection

export type TestAcpConnectionOptions = {
  url: string
  /** Caller-owned signal — aborting tears the probe's transport down. */
  signal?: AbortSignal
  /** Test seam — production omits and the factory builds a native WebSocket. */
  webSocketFactory?: WebSocketFactory
  /** Override the handshake timeout. Defaults to 10s, matching the model flow. */
  timeoutMs?: number
  /** Test seam — DI the transport opener. */
  openTransport?: OpenWebSocketTransport
  /** Test seam — DI the SDK connection constructor. */
  ClientSideConnection?: ClientSideConnectionCtor
}

export type TestAcpConnectionResult =
  | { success: true; capabilities: AgentCapabilities }
  | { success: false; error: string }

/** Translate a thrown probe error into a user-facing message. A bare network
 *  `TypeError` (DNS failure, refused socket) carries no useful text, so we swap
 *  in a friendly line; everything else surfaces its raw message. */
const toUserError = (err: unknown): string => {
  if (err instanceof TypeError) {
    return 'Could not reach agent'
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Open `url`, run the ACP `initialize` handshake, and report the agent's
 * capabilities. Races the handshake against `timeoutMs`; on timeout returns a
 * timed-out error. Always closes the transport.
 */
export const testAcpConnection = async (opts: TestAcpConnectionOptions): Promise<TestAcpConnectionResult> => {
  const openTransport = opts.openTransport ?? openWebSocketTransport
  const ConnectionCtor = opts.ClientSideConnection ?? ClientSideConnectionImpl
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs

  // `openWebSocketTransport` requires a concrete signal and already composes
  // caller aborts internally, so forward the caller's signal directly (or a
  // never-aborted one) — no intermediate controller needed.
  const signal = opts.signal ?? new AbortController().signal

  let transport: AcpTransport | null = null
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    transport = await openTransport({
      url: opts.url,
      signal,
      webSocketFactory: opts.webSocketFactory,
    })

    const connection = new ConnectionCtor(() => probeClient, transport.stream)

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Connection timed out')), timeoutMs)
    })

    const response = await Promise.race([
      connection.initialize({
        protocolVersion,
        clientInfo: { name: clientName, version: clientVersion },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      timeoutPromise,
    ])

    return { success: true, capabilities: adaptCapabilities(response) }
  } catch (err) {
    return { success: false, error: toUserError(err) }
  } finally {
    clearTimeout(timeoutId)
    transport?.close()
  }
}
