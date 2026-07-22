/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * iroh transport for ACP — the relay-only, peer-to-peer counterpart to the
 * WebSocket transport. Dials a `thunderbolt acp --transport iroh` CLI bridge by
 * its NodeId/ticket (carried in `agent.url`) over an n0 relay (or a self-hosted
 * one via `VITE_IROH_RELAY_URL`), end-to-end encrypted to the bridge.
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
import { irohAlpnFor } from '@shared/iroh'
import type { HttpClient } from '@/lib/http'
import { ensureSelfEnrollment } from '@/lib/iroh-enrollment'
import type { AcpTransport } from '../types'
import { createNdjsonDecoder, encodeNdjsonFrame } from './ndjson'
import type { IrohClientLike, IrohClientLoader, IrohConnectionLike } from './types'

/** ALPN of the CLI ACP bridge (`cli/src/iroh/endpoint.ts`,
 *  `thunderbolt/${protocol}/0`). Must match byte-for-byte or the QUIC handshake
 *  is refused — an ACP client can't drive an MCP bridge. */
export const acpIrohAlpn = irohAlpnFor('acp')

/** localStorage key for the persisted client secret key (hex). Persisting it
 *  pins a stable NodeId, so the bridge operator allowlists this app once. */
const secretStorageKey = 'iroh_acp_client_secret'

// ONE long-lived relay endpoint for the whole app — binding per dial would churn
// the relay handshake and the NodeId. All iroh transports share this client and
// open their own connection on it.
let sharedClient: Promise<IrohClientLike> | null = null

// Bumped by every wipe (sign-out / account-deletion / device-revocation). A bind
// samples this before its async work and only persists if it still matches, so a
// wipe that races an in-flight bind can't be silently undone by the bind re-writing
// the just-cleared secret.
let secretGeneration = 0

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

/**
 * Wipe the persisted iroh client secret and drop the in-memory binding.
 *
 * The secret IS the bridge access credential — it pins this app's NodeId, which a
 * bridge operator allowlists once. It currently lives in plaintext localStorage
 * (XSS-exfiltratable, and it outlives any patched XSS), so sign-out and account
 * deletion must clear it alongside the auth token and device id — `clearLocalData`
 * funnels all three teardowns (sign-out, account deletion, device revocation) here.
 * Resetting the shared client drops the in-memory identity, and bumping the
 * generation fences any bind that is still in flight so it can't re-persist the
 * wiped secret — the next dial re-binds a fresh NodeId instead.
 *
 * TODO: store the secret behind the encryption middleware so it never sits in
 * plaintext — see docs/architecture/e2e-encryption.md (same path the auth-token
 * TODO tracks).
 */
export const clearIrohClientSecret = (): void => {
  secretGeneration += 1
  sharedClient = null
  if (typeof localStorage === 'undefined') {
    return
  }
  localStorage.removeItem(secretStorageKey)
}

/** Bind via `bind`, then persist the resulting secret — but only if no wipe raced
 *  the bind. Sampling the generation before the async work and re-checking it after
 *  closes the sign-out TOCTOU: an in-flight bind that resolves after
 *  `clearIrohClientSecret` must not resurrect the cleared credential. */
const bindAndPersist = async (
  bind: () => Promise<{ client: IrohClientLike; secretHex: string }>,
): Promise<IrohClientLike> => {
  const boundAtGeneration = secretGeneration
  const { client, secretHex } = await bind()
  if (boundAtGeneration === secretGeneration) {
    persistSecret(secretHex)
  }
  return client
}

/** Build-time relay override (`VITE_IROH_RELAY_URL`). Unset/empty → `undefined`,
 *  so the wasm client keeps `presets::N0` (the n0 public relays — today's
 *  behavior); set it to a self-hosted iroh-relay wss URL to route every dial
 *  through it (n0 DNS discovery + crypto are kept, only the relay hop changes).
 *  Vite inlines this at build time, so switching relays is an env change + redeploy
 *  — no code edit. */
export const irohRelayUrl = (): string | undefined => {
  const url = import.meta.env.VITE_IROH_RELAY_URL?.trim()
  return url ? url : undefined
}

/** The wasm `IrohClient.create` factory, narrowed to the build-time relay
 *  override; the persisted secret is read INSIDE the factory (after wasm init) so
 *  its wipe-race timing is unchanged. Returns a client that also exposes its
 *  secret as hex. */
type IrohClientFactory = (relayUrl: string | undefined) => Promise<IrohClientLike & { secretKeyHex: () => string }>

/** Bind the wasm client, threading the build-time relay override into `create`.
 *  Split from {@link defaultLoadClient} so a fake `create` can assert the relay
 *  URL is forwarded without loading the multi-MB wasm chunk. The relay URL is a
 *  static build-time value (no wipe race), so reading it here — unlike the secret —
 *  is safe. */
export const bindIrohClient = async (
  create: IrohClientFactory,
): Promise<{ client: IrohClientLike; secretHex: string }> => {
  const client = await create(irohRelayUrl())
  return { client, secretHex: client.secretKeyHex() }
}

/** Lazy-load + bind the wasm iroh client, pinning a persisted identity and an
 *  optional self-hosted relay. The dynamic import is the route-split point — the
 *  multi-MB wasm chunk never lands in the entry bundle. `readPersistedSecret()`
 *  stays AFTER `wasm.default()` so the sign-out/wipe race window is byte-for-byte
 *  the pre-relay behavior. */
const defaultLoadClient: IrohClientLoader = () =>
  bindAndPersist(() =>
    bindIrohClient(async (relayUrl) => {
      const wasm = await import('./pkg/thunderbolt_acp_client.js')
      await wasm.default()
      const client = await wasm.IrohClient.create(readPersistedSecret(), relayUrl)
      return client as unknown as IrohClientLike & { secretKeyHex: () => string }
    }),
  )

/** Get (binding once) the shared iroh client. A failed bind clears the cache so
 *  a later attempt can retry rather than replaying a rejected promise forever.
 *  The eviction is identity-guarded: it clears the cache only if this exact bind
 *  is still the cached one, so a concurrent rebind (e.g. after an aborted dial
 *  already evicted this entry) is never clobbered by the old bind's late
 *  rejection. */
const getSharedClient = (load: IrohClientLoader): Promise<IrohClientLike> => {
  if (!sharedClient) {
    const pending: Promise<IrohClientLike> = load().catch((err: unknown) => {
      if (sharedClient === pending) {
        sharedClient = null
      }
      throw err
    })
    sharedClient = pending
  }
  return sharedClient
}

/** Evict the shared client iff `pending` is still the cached bind. Called when a
 *  dial is aborted while the shared bind is still in flight, so the next dial
 *  rebinds rather than awaiting a possibly-stuck endpoint. Never evicts a newer
 *  bind that has already replaced this one. */
const clearSharedClientIfPending = (pending: Promise<IrohClientLike>): void => {
  if (sharedClient === pending) {
    sharedClient = null
  }
}

/** Settle with `promise`, but reject with an `AbortError` the instant `signal`
 *  aborts — so a slow bind/dial over an offline or captive relay can't hang the
 *  caller (the wasm client warms the relay lazily on the first dial, so this is
 *  the only place that bounds it). `onAbort` runs only when the abort wins the
 *  race — to evict a stuck bind, or to close a connection that resolves too late
 *  to be used. The listener is detached as soon as `promise` settles, so it never
 *  leaks onto the adapter's long-lived signal. */
const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> => {
  if (signal.aborted) {
    onAbort?.()
    return Promise.reject(new DOMException('aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const abortListener = (): void => {
      onAbort?.()
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abortListener, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abortListener)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abortListener)
        reject(error)
      },
    )
  })
}

/** This app's iroh NodeId — what a bridge operator runs
 *  `thunderbolt iroh allow <node-id>` against. Binds the shared client on first
 *  call. Surfaced for the agent-settings UI (wired in a later slice). */
export const irohClientNodeId = async (load: IrohClientLoader = defaultLoadClient): Promise<string> =>
  (await getSharedClient(load)).nodeId()

export type DialIrohBridgeOptions = {
  /** EndpointTicket or bare NodeId printed by the CLI bridge. */
  target: string
  /** ALPN of the bridge protocol — must match the CLI byte-for-byte or the QUIC
   *  handshake is refused (e.g. {@link acpIrohAlpn} vs the MCP bridge's ALPN). */
  alpn: string
  /** Aborting cancels an in-flight bind/dial (and closes a connection that
   *  resolves too late to be used). */
  signal: AbortSignal
  /** Test seam — production omits and lazy-loads the wasm client. */
  loadClient?: IrohClientLoader
}

/**
 * Dial an iroh bridge `target` over the shared relay endpoint, opening one bidi
 * byte stream under `alpn`. The protocol-agnostic core both the ACP transport
 * (this file) and the MCP transport (`src/lib/mcp-iroh-transport.ts`) build their
 * framing on — one place owns the bind/dial abort-race handling.
 *
 * Races the bind AND the dial against the signal: the wasm client warms the relay
 * lazily on the first dial, so on an offline/captive network either step can take
 * a while — without racing, an abort would be a no-op until a listener is attached
 * downstream, hanging the caller. An abort during the bind evicts the shared
 * client so the next dial rebinds rather than awaiting a possibly-stuck endpoint;
 * an abort during the dial closes a connection that resolves too late, so a dial
 * that wins the race a tick after the abort can't leak a live QUIC stream nothing
 * will read or close.
 */
export const dialIrohBridge = async (options: DialIrohBridgeOptions): Promise<IrohConnectionLike> => {
  const { signal } = options
  // Bail before binding when already aborted, matching the WebSocket path (which
  // rejects with `AbortError`).
  if (signal.aborted) {
    throw new DOMException('aborted', 'AbortError')
  }

  const clientPromise = getSharedClient(options.loadClient ?? defaultLoadClient)
  const client = await raceAbort(clientPromise, signal, () => clearSharedClientIfPending(clientPromise))

  const connectPromise = client.connect(options.target, options.alpn)
  return raceAbort(connectPromise, signal, () => {
    void connectPromise.then((conn) => conn.close()).catch(() => {})
  })
}

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
  /** Authenticated backend client. Omitted only in true Standalone/test paths. */
  httpClient?: Pick<HttpClient, 'post'>
  /** Test seam for transparent enrollment ordering/fallback. */
  ensureEnrollment?: typeof ensureSelfEnrollment
}

/** Open an ACP transport against an iroh bridge `target`. Dials over the shared
 *  relay endpoint, opens one bidi stream, and frames ACP JSON-RPC as ndjson. */
export const openIrohTransport = async (options: OpenIrohTransportOptions): Promise<AcpTransport> => {
  if (options.httpClient) {
    await (options.ensureEnrollment ?? ensureSelfEnrollment)(options.httpClient, () =>
      irohClientNodeId(options.loadClient),
    )
  }

  const connection = await dialIrohBridge({
    target: options.target,
    alpn: options.alpn ?? acpIrohAlpn,
    signal: options.signal,
    loadClient: options.loadClient,
  })

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
      // Settle `closed` with the error FIRST (so `close()`'s `settleClosedOnce(null)`
      // no-ops), then route the rest of teardown through the same `close()` the
      // normal path uses — detaching the abort listener from the adapter's
      // long-lived signal and closing the QUIC connection. Without this, a recv
      // read error (or an oversized ndjson frame) would leak both. All of
      // `close()`'s steps are idempotent, so the double-call is safe.
      settleClosedOnce(error)
      close()
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

/** Reset the shared client and secret generation — tests only, so module state
 *  doesn't leak between cases. */
export const resetSharedIrohClientForTests = (): void => {
  sharedClient = null
  secretGeneration = 0
}

/** Test seam — drives {@link bindAndPersist}'s wipe-race guard with a fake bind,
 *  so the sign-out TOCTOU is covered without instantiating the real wasm client. */
export const bindAndPersistForTests = bindAndPersist
