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
import { dialIrohBridge, irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { createNdjsonDecoder, encodeNdjsonFrame } from '@/acp/iroh/ndjson'
import type { IrohClientLoader, IrohConnectionLike } from '@/acp/iroh/types'
import type { HttpClient } from '@/lib/http'
import { ensureSelfEnrollment } from '@/lib/iroh-enrollment'

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
 * Build an MCP SDK {@link Transport} that speaks JSON-RPC over an iroh bridge.
 *
 * Constructed synchronously; the dial happens in `start()` (which the MCP client
 * calls after installing the `onmessage`/`onerror`/`onclose` callbacks). `send`
 * frames the message as a single ndjson line onto the bidi stream; the receive
 * half is decoded back into messages delivered to `onmessage`. Mirrors the
 * ACP iroh transport's close/error discipline: one `closed` flag guards every
 * teardown path (clean EOF, read error, user `close()`, or an abort), so a late
 * frame, a double close, or a connection that resolves after an abort can't
 * enqueue-after-close or leak the QUIC stream.
 */
export const createMcpIrohTransport = (options: McpIrohTransportOptions): Transport => {
  const controller = new AbortController()
  const decoder = createNdjsonDecoder()
  let connection: IrohConnectionLike | null = null
  let started = false
  let closed = false

  // Single teardown path for every terminal condition. Idempotent via `closed`:
  // aborts the in-flight dial, closes the bidi stream, then surfaces an error (if
  // any) and the close to the SDK callbacks. `onclose` fires on every close,
  // including a user-initiated `close()`, per the Transport contract.
  const teardown = (error: Error | null): void => {
    if (closed) {
      return
    }
    closed = true
    controller.abort()
    connection?.close()
    if (error) {
      transport.onerror?.(error)
    }
    transport.onclose?.()
  }

  // Pump iroh recv bytes → ndjson decode → MCP messages, for the connection's
  // life. A read error or an oversized frame (the decoder throws) tears down with
  // the error; a clean EOF tears down cleanly.
  const pumpReceive = async (conn: IrohConnectionLike): Promise<void> => {
    try {
      const reader = conn.readable().getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done || closed) {
          break
        }
        for (const message of decoder.push(value)) {
          // Re-check inside the batch: an `onmessage` handler may close the
          // transport synchronously, and the remaining frames in this chunk must
          // not deliver after close.
          if (closed) {
            break
          }
          transport.onmessage?.(message as JSONRPCMessage)
        }
      }
      teardown(null)
    } catch (err) {
      teardown(err instanceof Error ? err : new Error(String(err)))
    }
  }

  const transport: Transport = {
    async start() {
      // One-shot, matching the SDK's own transports — a second start would dial a
      // second stream and orphan the first (`close()` only closes `connection`).
      if (started) {
        throw new Error('McpIrohTransport already started')
      }
      started = true
      if (options.httpClient) {
        await (options.ensureEnrollment ?? ensureSelfEnrollment)(options.httpClient, () =>
          irohClientNodeId(options.loadClient),
        )
      }
      connection = await dialIrohBridge({
        target: options.target,
        alpn: mcpIrohAlpn,
        signal: controller.signal,
        loadClient: options.loadClient,
      })
      void pumpReceive(connection)
    },
    async send(message) {
      // The SDK installs callbacks and calls `start()` before any `send()`, so a
      // missing connection here is a programming error, not a runtime branch.
      await connection!.send(encodeNdjsonFrame(message))
    },
    async close() {
      teardown(null)
    },
  }

  return transport
}
