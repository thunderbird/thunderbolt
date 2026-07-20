/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * iroh transport for the ACP/MCP bridge — the authenticated, P2P counterpart to
 * the loopback-only WebSocket bridge.
 *
 * Binds a server endpoint on the protocol's persistent identity and accepts
 * incoming connections from the n0 relays. The QUIC handshake authenticates the
 * peer's NodeId (an ed25519 key) for free; the allowlist is the authorization
 * gate on top of it. For each *allowed* connection the bridge spawns its own
 * stdio agent and pumps it over one bidi stream using the same ndjson framing as
 * the WebSocket path. Lifecycle is 1:1: a dropped connection kills the agent,
 * and an exiting agent ends the session by finishing its stream.
 */

import type { Connection, Incoming } from '@number0/iroh'
import type { BridgeConfig } from '../agent/types.ts'
import { atProcCapacity, redactArgv, spawnAgent, type BridgeProc } from '../commands/bridge.ts'
import { isAllowed } from './allowlist.ts'
import { bindServer } from './endpoint.ts'
import { killProcessWhenConnectionCloses } from './lifecycle.ts'
import { forwardFromRecv, forwardToSend, writeToStdin } from './pump.ts'

/** QUIC application close code for a connection we actively reject (allowlist
 *  miss or spawn failure). Normal end-of-session is signalled by finishing the
 *  stream and letting the client close, never by an active server-side close. */
export const closeRefused = 1n

/** Encode a human-readable connection-close reason as the byte array iroh wants. */
export const reasonBytes = (reason: string): number[] => Array.from(Buffer.from(reason, 'utf8'))

/** Per-remote handshake budget: how many connections one peer may open within
 *  {@link rateWindowMs} before we drop the excess *before* the TLS handshake.
 *  Generous enough that no legitimate client reconnecting hits it. */
const rateMax = 10
/** Sliding window for {@link rateMax}. */
const rateWindowMs = 10_000
/** Hard ceiling on distinct rate-limit keys. The map evicts least-recently-seen
 *  keys past this, so a flood of fresh (rotating) identities can't grow it. */
const rateMaxKeys = 4096
/** Max TLS handshakes allowed to run at once. This is the real CPU backstop: the
 *  per-remote budget is defeated by an attacker who mints a fresh EndpointId per
 *  connection, but a global cap bounds concurrent handshake cost regardless of
 *  identity. Generous enough that legitimate concurrent clients never hit it. */
const maxConcurrentHandshakes = 16
/** Hard ceiling on a single QUIC/TLS handshake. A peer that grabs a guard slot
 *  then stalls accept()/connect() would otherwise pin that slot forever; with
 *  {@link maxConcurrentHandshakes} such stalls every slot is held and legit
 *  clients are locked out at the guard. Past this deadline we abandon the
 *  handshake, releasing the slot. Generous enough that no real relay-routed
 *  handshake hits it. */
const defaultHandshakeTimeoutMs = 10_000
/** Hard ceiling on how long an allowlisted peer may take to open its bidi data
 *  stream after the handshake. The handshake guard slot is already released by
 *  this point, so this is not a handshake-DoS — but an allowlisted-but-idle peer
 *  that never opens the stream would pin the {@link Connection} indefinitely
 *  (QUIC's idle timeout is defeated by keepalives). Past this deadline we close
 *  the connection so it can't be held open for free. Generous enough that a real
 *  client opening its stream right after connecting never hits it. */
const defaultAcceptTimeoutMs = 10_000

/**
 * A lightweight per-key sliding-window rate limiter. `allow(key)` records the
 * call and returns whether the key is still within budget. A key's own stale
 * timestamps are pruned on each check; the backing map is hard-capped at
 * {@link rateMaxKeys} via least-recently-seen (insertion-order) eviction, so it
 * stays bounded even under a flood of fresh keys that never go stale in-window.
 *
 * @param max - calls allowed per window
 * @param windowMs - the window length in milliseconds
 * @param clock - current-time source (ms); injectable so the sliding window can
 *   be exercised deterministically without real waits
 * @param maxKeys - hard ceiling on distinct keys before least-recently-seen
 *   eviction; injectable so the bound can be tested cheaply
 */
export const createRateLimiter = (
  max: number,
  windowMs: number,
  clock: () => number = Date.now,
  maxKeys: number = rateMaxKeys,
): { allow: (key: string) => boolean } => {
  const hits = new Map<string, number[]>()

  const allow = (key: string): boolean => {
    const now = clock()
    // Map iterates in insertion order, so the first key is the oldest-touched.
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next().value
      if (oldest === undefined) break
      hits.delete(oldest)
    }
    const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs)
    if (recent.length >= max) {
      hits.set(key, recent)
      return false
    }
    recent.push(now)
    // Re-insert so an active key refreshes to newest, making eviction least-recent.
    hits.delete(key)
    hits.set(key, recent)
    return true
  }
  return { allow }
}

/**
 * A non-blocking counting semaphore. `tryAcquire` takes a slot if one is free
 * (returning whether it did); `release` returns one. Used to cap concurrent TLS
 * handshakes so handshake spam can't burn unbounded CPU before the allowlist gate.
 *
 * @param max - the number of slots
 */
export const createHandshakeGuard = (max: number): { tryAcquire: () => boolean; release: () => void } => {
  let inFlight = 0
  return {
    tryAcquire: () => {
      if (inFlight >= max) return false
      inFlight += 1
      return true
    },
    release: () => {
      if (inFlight > 0) inFlight -= 1
    },
  }
}

/** Derive a pre-handshake rate-limit key for an incoming connection. Relay-routed
 *  peers (our P2P model) expose their EndpointId before the handshake; direct IP
 *  peers expose `ip:port`. Falls back to the transport kind so a key always exists. */
export const remoteKey = async (incoming: Incoming): Promise<string> => {
  const addr = await incoming.remoteAddr()
  return addr.endpointId ?? addr.addr ?? addr.kind
}

/**
 * Complete the QUIC/TLS handshake for an incoming connection, releasing the
 * handshake guard slot the instant the handshake settles (success, failure, or
 * timeout) so the slot covers only the bounded handshake window, never the whole
 * session and never an indefinite stall.
 *
 * The handshake races a {@link defaultHandshakeTimeoutMs} deadline: a peer that takes a
 * guard slot then stalls accept()/connect() can't pin the slot — past the deadline
 * we abandon the wait and free the slot. The underlying handshake may still settle
 * afterwards; if it resolves late we close the orphaned connection so it can't leak.
 */
export const handshake = async (
  incoming: Incoming,
  guard: { release: () => void },
  timeoutMs: number = defaultHandshakeTimeoutMs,
): Promise<Connection> => {
  let timedOut = false
  const connecting = (async () => (await incoming.accept()).connect())()
  // Side-channel the late settle: if the deadline already won the race, close a
  // connection that completes afterwards. The single trailing `.catch` covers both
  // a late rejection (already surfaced by the race) and a throw from `close()`
  // itself (the NAPI binding can throw), so the void-discarded chain can never leak
  // an unhandled rejection. A peer that stalls *before* `accept()` yields a
  // Connection has no JS-visible handle to abort (the binding exposes only
  // `Connection.close()`); iroh's own QUIC transport timeout reaps that future, so
  // it's bounded, not an unbounded leak — and the guard slot is already freed below.
  void connecting
    .then((connection) => {
      if (timedOut) connection.close(closeRefused, reasonBytes('handshake timed out'))
    })
    .catch(() => undefined)

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error(`handshake exceeded ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([connecting, deadline])
  } finally {
    // Clears the timer on the win path so the deadline never rejects unhandled.
    clearTimeout(timer)
    guard.release()
  }
}

/** Type of the bidi stream pair iroh hands back from {@link Connection.acceptBi}. */
type BiStream = Awaited<ReturnType<Connection['acceptBi']>>

/**
 * Wait for the client to open its bidi data stream, bounded by a deadline. An
 * allowlisted-but-idle peer that never opens the stream would otherwise leave us
 * awaiting `acceptBi()` forever and pin the {@link Connection} (QUIC's idle timeout
 * is defeated by keepalives). Past the deadline we close the connection
 * ({@link closeRefused}) and resolve `null`. The discarded `acceptBi` promise is
 * pre-`.catch`'d so a late rejection (the close tears the stream down) can't leak
 * as an unhandled rejection.
 */
const acceptBidiStream = async (connection: Connection, timeoutMs: number): Promise<BiStream | null> => {
  const accepting = connection.acceptBi()
  void accepting.catch(() => undefined)

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      connection.close(closeRefused, reasonBytes('idle: no data stream opened'))
      resolve(null)
    }, timeoutMs)
  })

  try {
    return await Promise.race([accepting, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Handle a single incoming connection (its handshake guard slot already taken):
 * complete the handshake to learn the authenticated remote NodeId, enforce the
 * allowlist, wait (bounded) for the client to open the data stream, and only then
 * bridge a freshly-spawned agent over it.
 */
export const handleConnection = async (
  incoming: Incoming,
  config: BridgeConfig,
  activeProcs: Set<BridgeProc>,
  guard: { release: () => void },
  acceptTimeoutMs: number = defaultAcceptTimeoutMs,
): Promise<void> => {
  const connection = await handshake(incoming, guard)
  const remoteId = connection.remoteId().toString()

  if (!(await isAllowed(remoteId))) {
    process.stderr.write(`⚡ iroh bridge: refused ${remoteId} (not allowlisted)\n`)
    connection.close(closeRefused, reasonBytes('not allowlisted'))
    return
  }

  // Commit a subprocess only once the client actually opens the data stream, so
  // an allowlisted-but-idle peer can't pin a spawned agent, and the agent never
  // runs before its data plane exists. The wait is bounded: a peer that completes
  // the handshake (and passes the allowlist) but never opens the stream is closed
  // rather than left to pin the connection forever.
  const bi = await acceptBidiStream(connection, acceptTimeoutMs)
  if (!bi) {
    process.stderr.write(`⚡ iroh bridge: closed ${remoteId} (idle: no data stream)\n`)
    return
  }

  // Cap concurrently-live agents: the allowlist authorizes a *peer*, not a fixed
  // number of sessions, so one allowlisted peer holding many connections open
  // would otherwise spawn unbounded agents. At the ceiling we refuse rather than spawn.
  if (atProcCapacity(activeProcs)) {
    process.stderr.write(`⚡ iroh bridge: refused ${remoteId} (at capacity, ${activeProcs.size} live agents)\n`)
    connection.close(closeRefused, reasonBytes('bridge at capacity'))
    return
  }

  const proc = spawnAgent(config.command)
  if (!proc) {
    connection.close(closeRefused, reasonBytes(`failed to spawn '${config.command[0]}'`))
    return
  }
  activeProcs.add(proc)
  void proc.exited.then(() => activeProcs.delete(proc))
  // A dropped connection kills the agent. The reverse (agent exit) is signalled
  // by finishing the send stream below — never by an active connection close —
  // so the final JSON-RPC response can't be truncated mid-flight; the client
  // tears the connection down once it has drained that stream.
  killProcessWhenConnectionCloses(connection, proc)
  process.stdout.write(`⚡ iroh bridge: accepted ${remoteId} → spawned ${redactArgv(config.command)}\n`)

  // `.finally` (not `.then`) so the agent always gets stdin EOF, even if the
  // recv pump errors as the connection tears down. `writeToStdin` awaits the
  // flush (backpressure) and logs an EPIPE loudly rather than swallowing it.
  const toAgent = forwardFromRecv(bi.recv, (chunk) => writeToStdin(proc.stdin, chunk, 'bridge')).finally(() =>
    proc.stdin.end(),
  )
  const fromAgent = forwardToSend(proc.stdout, bi.send)
  // A pump rejecting here is the expected end-of-session (the stream errors as
  // the connection closes); the lifecycle hooks above have already cleaned up.
  await Promise.allSettled([toAgent, fromAgent])
}

/**
 * Start the iroh bridge: advertise this node's NodeId + ticket, then accept and
 * bridge connections until interrupted. Each connection is handled concurrently
 * so a slow or stalled session never blocks new peers; a SIGINT/SIGTERM kills
 * every spawned agent before exit so none are orphaned.
 */
export const runIrohBridge = async (config: BridgeConfig): Promise<void> => {
  const { endpoint, nodeId, ticket } = await bindServer(config.protocol)
  const activeProcs = new Set<BridgeProc>()
  // The QUIC handshake authenticates the peer's NodeId, but it runs *before* the
  // allowlist check below — so a peer that learns this NodeId could force endless
  // TLS handshakes. Two layers drop the excess pre-handshake: a per-remote budget
  // (fairness against a fixed peer) and a global concurrent-handshake cap (the CPU
  // backstop that holds even against an attacker rotating EndpointIds).
  const handshakeBudget = createRateLimiter(rateMax, rateWindowMs)
  const handshakeGuard = createHandshakeGuard(maxConcurrentHandshakes)

  process.stdout.write(
    `⚡ thunderbolt ${config.protocol} bridge (iroh) ready\n` +
      `   node id: ${nodeId}\n` +
      `   ticket:  ${ticket}\n` +
      `   spawning per connection: ${redactArgv(config.command)}\n` +
      `   allow a peer with: thunderbolt iroh allow <their-node-id>\n`,
  )

  const shutdown = (): void => {
    for (const proc of activeProcs) proc.kill()
    void endpoint.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  while (true) {
    const incoming = await endpoint.acceptNext()
    if (!incoming) break
    void admitConnection(incoming, config, activeProcs, handshakeBudget, handshakeGuard).catch((err) => {
      process.stderr.write(`⚡ iroh bridge: connection error: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }
}

/**
 * Gate one incoming connection before paying for its TLS handshake: first the
 * per-remote budget, then a free global handshake slot. A rejected connection is
 * `ignore()`d (dropped with no response — the cheapest rejection) so spam can't
 * burn CPU; an admitted one proceeds to {@link handleConnection}, which owns the
 * acquired slot and releases it once the handshake settles.
 */
export const admitConnection = async (
  incoming: Incoming,
  config: BridgeConfig,
  activeProcs: Set<BridgeProc>,
  handshakeBudget: { allow: (key: string) => boolean },
  handshakeGuard: { tryAcquire: () => boolean; release: () => void },
): Promise<void> => {
  const key = await remoteKey(incoming)
  if (!handshakeBudget.allow(key)) {
    process.stderr.write(`⚡ iroh bridge: rate-limited ${key} (too many handshakes)\n`)
    await incoming.ignore()
    return
  }
  if (!handshakeGuard.tryAcquire()) {
    process.stderr.write(`⚡ iroh bridge: at handshake capacity, dropped ${key}\n`)
    await incoming.ignore()
    return
  }
  await handleConnection(incoming, config, activeProcs, handshakeGuard)
}
