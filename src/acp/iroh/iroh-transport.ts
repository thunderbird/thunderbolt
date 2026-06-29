/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * iroh transport for ACP — the relay-only, peer-to-peer counterpart to the
 * WebSocket transport. Dials a `thunderbolt acp --transport iroh` CLI bridge by
 * its NodeId/ticket (carried in `agent.url`) over an n0 relay, end-to-end
 * encrypted to the bridge.
 *
 * The dial happens in a Rust→wasm client (`crates/thunderbolt-acp-client`) that
 * the browser can't replace with JS — iroh has no browser TS SDK. The wasm chunk
 * is lazy-loaded on first use (never in the entry bundle) and ONE relay endpoint
 * is shared across every iroh agent; each agent opens its own bidi stream.
 *
 * The bidi stream is a raw byte pipe, so this transport adds the same ndjson
 * framing the bridge uses (`./ndjson`) to carry ACP JSON-RPC objects, and adapts
 * it to the SDK's `{ readable, writable }` message `Stream`.
 */

import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import type { AcpTransport } from '../types'
import { createNdjsonDecoder, encodeNdjsonFrame } from './ndjson'
import type { IrohClientLike, IrohClientLoader } from './types'

/** ALPN of the CLI ACP bridge (`cli/src/iroh/endpoint.ts`,
 *  `thunderbolt/${protocol}/0`). Must match byte-for-byte or the QUIC handshake
 *  is refused — an ACP client can't drive an MCP bridge. */
export const acpIrohAlpn = 'thunderbolt/acp/0'

/** localStorage key for the persisted client secret key (hex). Persisting it
 *  pins a stable NodeId, so the bridge operator allowlists this app once. */
const secretStorageKey = 'iroh_acp_client_secret'

// ONE long-lived relay endpoint for the whole app — binding per dial would churn
// the relay handshake and the NodeId. All iroh transports share this client and
// open their own connection on it.
let sharedClient: Promise<IrohClientLike> | null = null

const readPersistedSecret = (): string | undefined => {
  if (typeof localStorage === 'undefined') {
    return undefined
  }
  return localStorage.getItem(secretStorageKey) ?? undefined
}

const persistSecret = (hex: string): void => {
  if (typeof localStorage === 'undefined') {
    return
  }
  localStorage.setItem(secretStorageKey, hex)
}

/** Lazy-load + bind the wasm iroh client, pinning a persisted identity. The
 *  dynamic import is the route-split point — the multi-MB wasm chunk never lands
 *  in the entry bundle. */
const defaultLoadClient: IrohClientLoader = async () => {
  const wasm = await import('./pkg/thunderbolt_acp_client.js')
  await wasm.default()
  const client = await wasm.IrohClient.create(readPersistedSecret())
  persistSecret(client.secretKeyHex())
  return client as unknown as IrohClientLike
}

/** Get (binding once) the shared iroh client. A failed bind clears the cache so
 *  a later attempt can retry rather than replaying a rejected promise forever. */
const getSharedClient = (load: IrohClientLoader): Promise<IrohClientLike> => {
  if (!sharedClient) {
    sharedClient = load().catch((err: unknown) => {
      sharedClient = null
      throw err
    })
  }
  return sharedClient
}

/** This app's iroh NodeId — what a bridge operator runs
 *  `thunderbolt iroh allow <node-id>` against. Binds the shared client on first
 *  call. Surfaced for the agent-settings UI (wired in a later slice). */
export const irohClientNodeId = async (load: IrohClientLoader = defaultLoadClient): Promise<string> =>
  (await getSharedClient(load)).nodeId()

export type OpenIrohTransportOptions = {
  /** EndpointTicket or bare NodeId printed by the CLI bridge (held in
   *  `agent.url` for an iroh agent). */
  target: string
  /** Aborting tears the transport (and its bidi stream) down. */
  signal: AbortSignal
  /** Override the ALPN (e.g. an MCP bridge). Defaults to {@link acpIrohAlpn}. */
  alpn?: string
  /** Test seam — production omits and lazy-loads the wasm client. */
  loadClient?: IrohClientLoader
}

/** Open an ACP transport against an iroh bridge `target`. Dials over the shared
 *  relay endpoint, opens one bidi stream, and frames ACP JSON-RPC as ndjson. */
export const openIrohTransport = async (options: OpenIrohTransportOptions): Promise<AcpTransport> => {
  const client = await getSharedClient(options.loadClient ?? defaultLoadClient)
  const connection = await client.connect(options.target, options.alpn ?? acpIrohAlpn)

  // If the caller aborted while we were binding/dialing, don't hand back a live
  // connection — close it and surface the abort, matching the WebSocket path
  // (which rejects with `AbortError`). No await follows until the listener is
  // attached, so there's no further abort window to miss.
  if (options.signal.aborted) {
    connection.close()
    throw new DOMException('aborted', 'AbortError')
  }

  // `closed` rejects on a transport-level read error and resolves on clean EOF /
  // caller close, so the adapter's handshake can race it and fail loudly instead
  // of hanging on a pending `initialize` (mirrors the WebSocket transport).
  let settleClosed: ((reason: Error | null) => void) | null = null
  const closed = new Promise<void>((resolve, reject) => {
    settleClosed = (reason) => (reason ? reject(reason) : resolve())
  })
  closed.catch(() => {})
  const settleClosedOnce = (reason: Error | null): void => {
    if (!settleClosed) {
      return
    }
    const settle = settleClosed
    settleClosed = null
    settle(reason)
  }

  const decoder = createNdjsonDecoder()
  let readableController: ReadableStreamDefaultController<AnyMessage> | null = null
  let readableClosed = false
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      readableController = controller
    },
  })

  // Guard every controller op behind one flag so a normal close, a read error,
  // and a consumer cancel can't double-close/enqueue-after-close (the same
  // discipline the WebSocket transport uses).
  const closeReadable = (): void => {
    if (readableClosed) {
      return
    }
    readableClosed = true
    readableController?.close()
  }

  // `close` is also the abort listener, so a normal close detaches it (rather
  // than leaving it attached to the adapter's long-lived signal). Idempotent:
  // `closeReadable`, `settleClosedOnce`, and the wasm `connection.close()` all
  // no-op on re-entry. Defined before `writable`/`pumpReceive` so both route
  // their teardown through this single path.
  const close = (): void => {
    options.signal.removeEventListener('abort', close)
    closeReadable()
    connection.close()
    settleClosedOnce(null)
  }

  // Pump iroh recv bytes → ndjson decode → ACP messages, for the session's life.
  const pumpReceive = async (): Promise<void> => {
    const reader = connection.readable().getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done || readableClosed) {
          break
        }
        for (const message of decoder.push(value)) {
          readableController?.enqueue(message as AnyMessage)
        }
      }
      closeReadable()
      settleClosedOnce(null)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (!readableClosed) {
        readableClosed = true
        readableController?.error(error)
      }
      settleClosedOnce(error)
    }
  }
  void pumpReceive()

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      await connection.send(encodeNdjsonFrame(message))
    },
    close() {
      close()
    },
    abort() {
      close()
    },
  })

  const stream: Stream = { readable, writable }

  options.signal.addEventListener('abort', close, { once: true })

  return { stream, close, closed }
}

/** Reset the shared client — tests only, so module state doesn't leak between
 *  cases. */
export const resetSharedIrohClientForTests = (): void => {
  sharedClient = null
}
