/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * iroh transport for the ACP/MCP bridge — the authenticated, P2P counterpart to
 * the loopback-only WebSocket bridge.
 *
 * Binds a server endpoint on this machine's persistent identity and accepts
 * incoming connections from the n0 relays. The QUIC handshake authenticates the
 * peer's NodeId (an ed25519 key) for free; the allowlist is the authorization
 * gate on top of it. For each *allowed* connection the bridge spawns its own
 * stdio agent and pumps it over one bidi stream using the same ndjson framing as
 * the WebSocket path. Lifecycle is 1:1: a dropped connection kills the agent,
 * and an exiting agent ends the session by finishing its stream.
 */

import type { Connection, Incoming } from '@number0/iroh'
import type { BridgeConfig } from '../agent/types.ts'
import { spawnAgent, type BridgeProc } from '../commands/bridge.ts'
import { isAllowed } from './allowlist.ts'
import { bindServer } from './endpoint.ts'
import { forwardFromRecv, forwardToSend, writeToStdin } from './pump.ts'

/** QUIC application close code for a connection we actively reject (allowlist
 *  miss or spawn failure). Normal end-of-session is signalled by finishing the
 *  stream and letting the client close, never by an active server-side close. */
const CLOSE_REFUSED = 1n

/** Encode a human-readable connection-close reason as the byte array iroh wants. */
const reasonBytes = (reason: string): number[] => Array.from(Buffer.from(reason, 'utf8'))

/** Per-remote handshake budget: how many connections one peer may open within
 *  {@link RATE_WINDOW_MS} before we drop the excess *before* the TLS handshake.
 *  Generous enough that no legitimate client reconnecting hits it. */
const RATE_MAX = 10
/** Sliding window for {@link RATE_MAX}. */
const RATE_WINDOW_MS = 10_000
/** Hard ceiling on distinct rate-limit keys. The map evicts least-recently-seen
 *  keys past this, so a flood of fresh (rotating) identities can't grow it. */
const RATE_MAX_KEYS = 4096
/** Max TLS handshakes allowed to run at once. This is the real CPU backstop: the
 *  per-remote budget is defeated by an attacker who mints a fresh EndpointId per
 *  connection, but a global cap bounds concurrent handshake cost regardless of
 *  identity. Generous enough that legitimate concurrent clients never hit it. */
const MAX_CONCURRENT_HANDSHAKES = 16

/**
 * A lightweight per-key sliding-window rate limiter. `allow(key)` records the
 * call and returns whether the key is still within budget. A key's own stale
 * timestamps are pruned on each check; the backing map is hard-capped at
 * {@link RATE_MAX_KEYS} via least-recently-seen (insertion-order) eviction, so it
 * stays bounded even under a flood of fresh keys that never go stale in-window.
 *
 * @param max - calls allowed per window
 * @param windowMs - the window length in milliseconds
 */
const createRateLimiter = (max: number, windowMs: number): { allow: (key: string) => boolean } => {
  const hits = new Map<string, number[]>()

  const allow = (key: string): boolean => {
    const now = Date.now()
    // Map iterates in insertion order, so the first key is the oldest-touched.
    while (hits.size > RATE_MAX_KEYS) {
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
const createHandshakeGuard = (max: number): { tryAcquire: () => boolean; release: () => void } => {
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
const remoteKey = async (incoming: Incoming): Promise<string> => {
  const addr = await incoming.remoteAddr()
  return addr.endpointId ?? addr.addr ?? addr.kind
}

/**
 * Complete the QUIC/TLS handshake for an incoming connection, releasing the
 * handshake guard slot the instant the handshake settles (success or failure) so
 * the slot covers only the CPU-bound handshake window, never the whole session.
 */
const handshake = async (incoming: Incoming, guard: { release: () => void }): Promise<Connection> => {
  try {
    return await (await incoming.accept()).connect()
  } finally {
    guard.release()
  }
}

/**
 * Handle a single incoming connection (its handshake guard slot already taken):
 * complete the handshake to learn the authenticated remote NodeId, enforce the
 * allowlist, wait for the client to open the data stream, and only then bridge a
 * freshly-spawned agent over it.
 */
const handleConnection = async (
  incoming: Incoming,
  config: BridgeConfig,
  activeProcs: Set<BridgeProc>,
  guard: { release: () => void },
): Promise<void> => {
  const connection = await handshake(incoming, guard)
  const remoteId = connection.remoteId().toString()

  if (!(await isAllowed(remoteId))) {
    process.stderr.write(`⚡ iroh bridge: refused ${remoteId} (not allowlisted)\n`)
    connection.close(CLOSE_REFUSED, reasonBytes('not allowlisted'))
    return
  }

  // Commit a subprocess only once the client actually opens the data stream, so
  // an allowlisted-but-idle peer can't pin a spawned agent, and the agent never
  // runs before its data plane exists.
  const bi = await connection.acceptBi()

  const proc = spawnAgent(config.command)
  if (!proc) {
    connection.close(CLOSE_REFUSED, reasonBytes(`failed to spawn '${config.command[0]}'`))
    return
  }
  activeProcs.add(proc)
  void proc.exited.then(() => activeProcs.delete(proc))
  // A dropped connection kills the agent. The reverse (agent exit) is signalled
  // by finishing the send stream below — never by an active connection close —
  // so the final JSON-RPC response can't be truncated mid-flight; the client
  // tears the connection down once it has drained that stream.
  void connection.closed().then(() => proc.kill())
  process.stdout.write(`⚡ iroh bridge: accepted ${remoteId} → spawned ${config.command.join(' ')}\n`)

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
  const handshakeBudget = createRateLimiter(RATE_MAX, RATE_WINDOW_MS)
  const handshakeGuard = createHandshakeGuard(MAX_CONCURRENT_HANDSHAKES)

  process.stdout.write(
    `⚡ thunderbolt ${config.protocol} bridge (iroh) ready\n` +
      `   node id: ${nodeId}\n` +
      `   ticket:  ${ticket}\n` +
      `   spawning per connection: ${config.command.join(' ')}\n` +
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
const admitConnection = async (
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
