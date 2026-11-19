/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * MCP transport over iroh — the peer-to-peer counterpart to the http/sse remote
 * transports. Dials a `thunderbolt mcp --transport iroh -- <server>` CLI bridge
 * by its NodeId/ticket (carried in the server's `url` field) over an n0 relay,
 * end-to-end encrypted to the bridge.
 *
 * Reuses the EXACT iroh stack the ACP transport uses: the shared, lazily-bound
 * wasm relay client (`dialIrohBridge`) and the ndjson framing
 * (`encodeNdjsonFrame`/`createNdjsonDecoder`). The only difference from ACP is the
 * ALPN and that this adapts the raw bidi byte stream to the MCP SDK's `Transport`
 * interface (callback-based) rather than ACP's `{ readable, writable }` Stream.
 *
 * No proxy, bearer, or CORS applies to the relay link — it is encrypted and the
 * bridge is allowlist-gated by NodeId (`thunderbolt iroh allow <id>`). Before
 * dialing, the authenticated app client best-effort enrolls this device's NodeId.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { irohAlpnFor } from '@shared/iroh'
import { openIrohTransport } from '@/acp/iroh/iroh-transport'
import type { AcpTransport } from '@/acp/types'
import type { AnyMessage } from '@agentclientprotocol/sdk'
import type { IrohClientLoader } from '@/acp/iroh/types'
import { TransportTerminationError } from '@/acp/termination'
import type { HttpClient } from '@/lib/http'
import type { ensureSelfEnrollment } from '@/lib/iroh-enrollment'

/** ALPN of the CLI MCP bridge (`cli/src/iroh/endpoint.ts`, `thunderbolt/mcp/0`).
 *  Must match byte-for-byte or the QUIC handshake is refused. */
export const mcpIrohAlpn = irohAlpnFor('mcp')

export type McpIrohTransportOptions = {
  /** EndpointTicket or bare NodeId printed by the CLI MCP bridge. */
  target: string
  /** Test seam — production omits and lazy-loads the shared wasm client. */
  loadClient?: IrohClientLoader
  /** Authenticated backend client. Omitted only in true Standalone/test paths. */
  httpClient?: Pick<HttpClient, 'post'>
  /** Test seam for transparent enrollment ordering/fallback. */
  ensureEnrollment?: typeof ensureSelfEnrollment
}

/**
 * Adapt the shared framed iroh transport to MCP's callback API. The raw
 * connection, reader cancellation, framing and terminal cleanup belong to
 * openIrohTransport; this adapter owns only SDK start/notification semantics.
 */
export const createMcpIrohTransport = (options: McpIrohTransportOptions): Transport => {
  const controller = new AbortController()
  let writer: WritableStreamDefaultWriter<AnyMessage> | null = null
  let started = false

  const finish = (error: Error | null): void => {
    if (controller.signal.aborted) {
      return
    }
    controller.abort()
    if (error) {
      transport.onerror?.(error)
    }
    transport.onclose?.()
  }

  const receive = async (opened: AcpTransport): Promise<void> => {
    const reader = opened.stream.readable.getReader()
    try {
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read()
        if (done || controller.signal.aborted) {
          break
        }
        transport.onmessage?.(value as JSONRPCMessage)
      }
      finish(null)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    } finally {
      reader.releaseLock()
    }
  }

  const transport: Transport = {
    async start() {
      if (started) {
        throw new Error('McpIrohTransport already started')
      }
      started = true
      const opened = await openIrohTransport({ ...options, alpn: mcpIrohAlpn, signal: controller.signal })
      if (controller.signal.aborted) {
        opened.close()
        throw controller.signal.reason
      }
      writer = opened.stream.writable.getWriter()
      void receive(opened)
    },
    async send(message) {
      if (controller.signal.aborted) {
        throw new TransportTerminationError('remote-close', 'MCP transport is closed')
      }
      if (!writer) {
        throw new Error('McpIrohTransport has not started')
      }
      try {
        await writer.write(message as AnyMessage)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    },
    async close() {
      finish(null)
    },
  }
  return transport
}
