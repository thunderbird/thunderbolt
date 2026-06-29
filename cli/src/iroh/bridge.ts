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

import type { Incoming } from '@number0/iroh'
import type { BridgeConfig } from '../agent/types.ts'
import { spawnAgent, type BridgeProc } from '../commands/bridge.ts'
import { isAllowed } from './allowlist.ts'
import { bindServer } from './endpoint.ts'
import { forwardFromRecv, forwardToSend } from './pump.ts'

/** QUIC application close code for a connection we actively reject (allowlist
 *  miss or spawn failure). Normal end-of-session is signalled by finishing the
 *  stream and letting the client close, never by an active server-side close. */
const CLOSE_REFUSED = 1n

/** Encode a human-readable connection-close reason as the byte array iroh wants. */
const reasonBytes = (reason: string): number[] => Array.from(Buffer.from(reason, 'utf8'))

/**
 * Handle a single incoming connection: complete the handshake to learn the
 * authenticated remote NodeId, enforce the allowlist, wait for the client to
 * open the data stream, and only then bridge a freshly-spawned agent over it.
 */
const handleConnection = async (
  incoming: Incoming,
  config: BridgeConfig,
  activeProcs: Set<BridgeProc>,
): Promise<void> => {
  const connection = await (await incoming.accept()).connect()
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
  // recv pump errors as the connection tears down.
  const toAgent = forwardFromRecv(bi.recv, (chunk) => {
    proc.stdin.write(chunk)
    proc.stdin.flush()
  }).finally(() => proc.stdin.end())
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
    void handleConnection(incoming, config, activeProcs).catch((err) => {
      process.stderr.write(`⚡ iroh bridge: connection error: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }
}
