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
import { hostname } from 'node:os'
import type { BridgeConfig } from '../agent/types.ts'
import { isSecureCloudUrl, resolveAppUrl } from '../auth/config.ts'
import type { Clock } from '../auth/device-grant.ts'
import { resolveBridgeCredential } from '../auth/token-store.ts'
import { atProcCapacity, redactArgv, spawnAgent, type BridgeProc } from '../commands/bridge.ts'
import {
  BridgeDeviceRevokedError,
  createAccountAllowlist,
  fetchAccountAllowlist,
  registerBridgeWithBackend,
  type AccountAllowlist,
  type FetchFn,
} from './account-allowlist.ts'
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

/** Cadence of the membership heartbeat: refresh the account allowlist and
 *  re-check every open connection against it. 45s is the revocation-propagation SLA
 *  — a revoked device's live session is torn down within one interval. */
export const heartbeatIntervalMs = 45_000

/** Background time seam for the heartbeat: like the login poll's `systemClock`, but
 *  its sleep timer is `unref`'d so a pending heartbeat sleep never keeps the process
 *  alive past a clean shutdown. The accept loop (awaiting the endpoint) holds the
 *  process up while serving; once it ends, this timer must not block exit. */
const backgroundClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.()
    }),
}

/** A live bridged session, tracked so the heartbeat can re-check its peer's
 *  membership and tear it down if the account revokes it mid-session. */
export type OpenConnection = {
  readonly remoteId: string
  readonly connection: Pick<Connection, 'close'>
}

/** Optional per-bridge trust context threaded into connection handling: the cached
 *  account allowlist (absent in Standalone / no-account mode) and the open-connection
 *  registry the heartbeat re-checks. `acceptTimeoutMs` stays overridable for tests. */
export type HandleConnectionOptions = {
  readonly accountAllowlist?: AccountAllowlist
  readonly openConnections?: Set<OpenConnection>
  readonly acceptTimeoutMs?: number
}

/**
 * The bridge trust gate: a peer is admitted if its authenticated NodeId is in
 * the cached same-account allowlist (auto-trust) OR the manual `iroh allow` file
 * (Standalone / cross-account / CI). The account allowlist is checked first and
 * short-circuits, so the manual file is only read when auto-trust doesn't cover the
 * peer. The QUIC handshake has already authenticated `remoteId`, so this is pure
 * authorization over a proven identity.
 *
 * @param remoteId - the handshake-authenticated peer NodeId
 * @param accountAllowlist - the cached account allowlist, or `undefined` (Standalone)
 */
export const isConnectionAllowed = async (remoteId: string, accountAllowlist?: AccountAllowlist): Promise<boolean> =>
  (accountAllowlist?.has(remoteId) ?? false) || isAllowed(remoteId)

/**
 * One heartbeat cycle: refresh the cached account allowlist, then tear down
 * every open connection whose peer is no longer allowed (account-revoked AND absent
 * from the manual file). A still-allowed peer is untouched — the heartbeat is a
 * no-op for legit sessions. Closing the connection triggers the same lifecycle the
 * peer's own disconnect would (agent killed, registry pruned) via the hooks wired in
 * {@link handleConnection}. Exported so a single tick is unit-testable directly.
 *
 * Self-revocation: if the refreshed allowlist no longer lists this bridge's own
 * NodeId, the account has revoked *this device*. The allowlist then reports every
 * account peer as untrusted, so the per-connection sweep below tears down all
 * same-account sessions. Manual-file peers survive because manual trust persists; one
 * log entry per tick makes the revocation visible in the bridge logs.
 *
 * Each peer's re-check is isolated: a thrown manual-file read or a `close()` that
 * throws (the NAPI binding can) is logged and skipped, never aborting the sweep or
 * killing the loop — the revocation check must survive one bad connection.
 *
 * @param accountAllowlist - the cached account allowlist to refresh and check against
 * @param openConnections - the live sessions to re-check
 */
export const heartbeatTick = async (
  accountAllowlist: AccountAllowlist,
  openConnections: Set<OpenConnection>,
): Promise<void> => {
  await accountAllowlist.refresh()
  if (accountAllowlist.isSelfRevoked()) {
    process.stderr.write(
      '⚡ iroh bridge: this device is no longer in the account allowlist — account auto-trust disabled, tearing down same-account sessions (manual allowlist still active)\n',
    )
  }
  for (const open of openConnections) {
    try {
      if (await isConnectionAllowed(open.remoteId, accountAllowlist)) continue
      process.stderr.write(`⚡ iroh bridge: ${open.remoteId} revoked mid-session — closing\n`)
      open.connection.close(closeRefused, reasonBytes('membership revoked'))
    } catch (err) {
      process.stderr.write(
        `⚡ iroh bridge: heartbeat re-check failed for ${open.remoteId}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
}

/**
 * Run the membership heartbeat on {@link heartbeatIntervalMs} cadence until
 * stopped, sleeping via the injected {@link Clock} so tests drive it without real
 * timers. Each cycle {@link heartbeatTick}s; refresh + per-connection re-checks are
 * error-isolated, so the loop never dies. Returns a stop function that ends the loop
 * after the current sleep (the {@link backgroundClock} sleep is `unref`'d, so a
 * pending cycle can't hold the process up meanwhile).
 *
 * @param accountAllowlist - the allowlist refreshed each cycle
 * @param openConnections - the live sessions re-checked each cycle
 * @param clock - injected time seam (real: {@link backgroundClock})
 * @param intervalMs - cycle cadence (default {@link heartbeatIntervalMs})
 */
export const startMembershipHeartbeat = (
  accountAllowlist: AccountAllowlist,
  openConnections: Set<OpenConnection>,
  clock: Clock = backgroundClock,
  intervalMs: number = heartbeatIntervalMs,
): (() => void) => {
  let running = true
  void (async () => {
    while (running) {
      await clock.sleep(intervalMs)
      if (!running) break
      await heartbeatTick(accountAllowlist, openConnections)
    }
  })()
  return () => {
    running = false
  }
}

/**
 * Handle a single incoming connection (its handshake guard slot already taken):
 * complete the handshake to learn the authenticated remote NodeId, enforce the
 * trust gate ({@link isConnectionAllowed}), wait (bounded) for the client to open
 * the data stream, and only then bridge a freshly-spawned agent over it.
 */
export const handleConnection = async (
  incoming: Incoming,
  config: BridgeConfig,
  activeProcs: Set<BridgeProc>,
  guard: { release: () => void },
  opts: HandleConnectionOptions = {},
): Promise<void> => {
  const connection = await handshake(incoming, guard)
  const remoteId = connection.remoteId().toString()

  if (!(await isConnectionAllowed(remoteId, opts.accountAllowlist))) {
    process.stderr.write(`⚡ iroh bridge: refused ${remoteId} (not allowlisted)\n`)
    connection.close(closeRefused, reasonBytes('not allowlisted'))
    return
  }

  // Commit a subprocess only once the client actually opens the data stream, so
  // an allowlisted-but-idle peer can't pin a spawned agent, and the agent never
  // runs before its data plane exists. The wait is bounded: a peer that completes
  // the handshake (and passes the allowlist) but never opens the stream is closed
  // rather than left to pin the connection forever.
  const bi = await acceptBidiStream(connection, opts.acceptTimeoutMs ?? defaultAcceptTimeoutMs)
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
  const openConnections = opts.openConnections
  if (openConnections) {
    const open: OpenConnection = { remoteId, connection }
    openConnections.add(open)
    const removeOpenConnection = (): boolean => openConnections.delete(open)
    void connection.closed().then(removeOpenConnection, removeOpenConnection)
  }
  void proc.exited.then(() => activeProcs.delete(proc))
  // A dropped connection kills the agent and removes the heartbeat registry entry.
  // The reverse (agent exit) is signalled by finishing the send stream below —
  // never by an active connection close — so the final JSON-RPC response can't be
  // truncated mid-flight; the client tears the connection down once it has drained
  // that stream.
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

/** Live same-account trust for a running bridge: the cached account allowlist and a
 *  stop for its heartbeat. Absent when the CLI isn't logged in (Standalone). */
type AccountTrust = { readonly accountAllowlist: AccountAllowlist; readonly stop: () => void }

/** Format the startup banner's account-trust status from the initialized trust state. */
export const accountTrustBanner = (enabled: boolean): string =>
  enabled
    ? '   same-account auto-trust: on (backend allowlist, 45s heartbeat)\n'
    : '   same-account auto-trust: off (manual allowlist only)\n' +
      '   allow a peer with: thunderbolt iroh allow <their-node-id>\n'

/**
 * Render startup details, including exact app page where this bridge is paired.
 *
 * @param config - bridge protocol, transport, port, and spawned command
 * @param nodeId - bridge's public iroh node id
 * @param ticket - bridge's current iroh connection ticket
 * @param accountTrustEnabled - whether same-account auto-trust initialized
 * @param appUrl - Thunderbolt app base URL
 */
export const renderIrohBridgeBanner = (
  config: BridgeConfig,
  nodeId: string,
  ticket: string,
  accountTrustEnabled: boolean,
  appUrl: string = resolveAppUrl(),
): string => {
  const settingsPath = config.protocol === 'acp' ? '/settings/agents' : '/settings/mcp-servers'
  const pairingUrl = `${appUrl.replace(/\/+$/, '')}${settingsPath}`
  return (
    `⚡ thunderbolt ${config.protocol} bridge (iroh) ready\n` +
    `   node id: ${nodeId}\n` +
    `   ticket:  ${ticket}\n` +
    `   pair in Thunderbolt app: ${pairingUrl}\n` +
    `   spawning per connection: ${redactArgv(config.command)}\n` +
    accountTrustBanner(accountTrustEnabled)
  )
}

/**
 * Wire same-account auto-trust when this bridge has a backend credential:
 * resolve it (env PAT via `x-api-key`, else the stored device-grant session bearer),
 * self-register the bridge's bare NodeId, prime the account allowlist before any
 * connection is accepted, and start the 45s membership heartbeat. Returns live
 * account trust only when registration and priming both succeed. Never throws:
 * credential, registration, and prime failures disable account trust for this run,
 * while the manual allowlist remains active.
 *
 * Re-checks the credential's `cloudUrl` against the same secure-transport policy
 * `login` enforced (`isSecureCloudUrl`) before sending the credential: a tampered /
 * cleartext non-loopback URL disables account trust rather than leaking it.
 *
 * The bridge's own `selfNodeId` is threaded into the allowlist. If a refresh no longer
 * lists it, the account revoked this device, so account auto-trust is disabled.
 *
 * @param openConnections - the live-session registry the heartbeat re-checks
 * @param selfNodeId - this bridge's own NodeId, used to detect self-revocation
 * @param fetchFn - HTTP fetch dependency used for registration and allowlist priming
 */
export const startAccountTrust = async (
  openConnections: Set<OpenConnection>,
  selfNodeId: string,
  fetchFn: FetchFn = fetch,
): Promise<AccountTrust | undefined> => {
  try {
    const credential = await resolveBridgeCredential()
    if (!credential) return undefined
    if (!isSecureCloudUrl(credential.cloudUrl)) {
      throw new Error(`cloud URL is not a secure transport (${credential.cloudUrl})`)
    }
    await registerBridgeWithBackend(credential, selfNodeId, hostname() || 'Bridge', fetchFn)
    const initialNodeIds = await fetchAccountAllowlist(credential, fetchFn)
    const accountAllowlist = createAccountAllowlist(
      () => fetchAccountAllowlist(credential, fetchFn),
      selfNodeId,
      initialNodeIds,
    )
    const stop = startMembershipHeartbeat(accountAllowlist, openConnections)
    return { accountAllowlist, stop }
  } catch (err) {
    if (err instanceof BridgeDeviceRevokedError) {
      process.stderr.write(`⚡ iroh bridge: ${err.message}\n`)
      return undefined
    }
    process.stderr.write(
      `⚡ iroh bridge: account auto-trust disabled: ${err instanceof Error ? err.message : String(err)}; using manual allowlist only\n`,
    )
    return undefined
  }
}

/**
 * Start the iroh bridge: advertise this node's NodeId + ticket, then accept and
 * bridge connections until interrupted. Each connection is handled concurrently
 * so a slow or stalled session never blocks new peers; a SIGINT/SIGTERM kills
 * every spawned agent before exit so none are orphaned. When the CLI is logged in
 * to an account, same-account peers are auto-trusted from the backend allowlist and
 * re-checked on a 45s heartbeat; otherwise the manual `iroh allow` file is the gate.
 */
export const runIrohBridge = async (config: BridgeConfig): Promise<void> => {
  const { endpoint, nodeId, ticket } = await bindServer(config.protocol)
  const activeProcs = new Set<BridgeProc>()
  const openConnections = new Set<OpenConnection>()
  // The QUIC handshake authenticates the peer's NodeId, but it runs *before* the
  // allowlist check below — so a peer that learns this NodeId could force endless
  // TLS handshakes. Two layers drop the excess pre-handshake: a per-remote budget
  // (fairness against a fixed peer) and a global concurrent-handshake cap (the CPU
  // backstop that holds even against an attacker rotating EndpointIds).
  const handshakeBudget = createRateLimiter(rateMax, rateWindowMs)
  const handshakeGuard = createHandshakeGuard(maxConcurrentHandshakes)
  const accountTrust = await startAccountTrust(openConnections, nodeId)

  process.stdout.write(renderIrohBridgeBanner(config, nodeId, ticket, accountTrust !== undefined))

  const shutdown = (): void => {
    accountTrust?.stop()
    for (const proc of activeProcs) proc.kill()
    void endpoint.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Only track open connections when the heartbeat is live to re-check them; in
  // Standalone there is nothing to consume the registry, so we don't populate it.
  const opts: HandleConnectionOptions = accountTrust
    ? { accountAllowlist: accountTrust.accountAllowlist, openConnections }
    : {}
  while (true) {
    const incoming = await endpoint.acceptNext()
    if (!incoming) break
    void admitConnection(incoming, config, activeProcs, handshakeBudget, handshakeGuard, opts).catch((err) => {
      process.stderr.write(`⚡ iroh bridge: connection error: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }
  // The accept loop only ends when the endpoint closes; end the heartbeat loop so no
  // further tick runs after the endpoint is gone.
  accountTrust?.stop()
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
  opts: HandleConnectionOptions = {},
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
  await handleConnection(incoming, config, activeProcs, handshakeGuard, opts)
}
