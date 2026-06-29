/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * iroh endpoint helpers: bind a server (agent host) or dial a peer (controller),
 * both pinned to this machine's persistent identity and speaking one ALPN.
 *
 * Transport shape (verified against the n0 relays):
 *   builder → presetN0 (relays + discovery + crypto) → secretKey (stable NodeId)
 *   → [server only] alpns → bind → online (home relay ready).
 * A connection ticket embeds the NodeId + home-relay URL, so it is the natural
 * out-of-band pairing primitive; a bare NodeId also dials via n0 DNS discovery.
 */

import { Endpoint, EndpointAddr, EndpointId, EndpointTicket, presetN0 } from '@number0/iroh'
import type { Connection } from '@number0/iroh'
import type { BridgeProtocol } from '../agent/types.ts'
import { loadOrCreateIdentity } from './identity.ts'

/** Per-protocol ALPN: one string per protocol version. Both peers must match or
 *  the handshake is refused — so an ACP client can't drive an MCP bridge (or
 *  vice-versa) even though both bind on the same identity. */
const alpnStringFor = (protocol: BridgeProtocol): string => `thunderbolt/${protocol}/0`

/** The protocol's ALPN as the byte array the iroh API expects. */
export const alpnFor = (protocol: BridgeProtocol): number[] => Array.from(Buffer.from(alpnStringFor(protocol), 'utf8'))

/** A bound server endpoint plus the two identifiers operators share to be
 *  reached: the bare NodeId and a full connection ticket (NodeId + relay). */
export type ServerEndpoint = {
  readonly endpoint: Endpoint
  readonly nodeId: string
  readonly ticket: string
}

/** A dialed peer: the live connection and the local endpoint backing it. */
export type DialedEndpoint = {
  readonly endpoint: Endpoint
  readonly connection: Connection
}

/**
 * Bind a server endpoint on this machine's persistent identity, advertising the
 * protocol's ALPN, and wait until a home relay is usable so the returned ticket
 * is dialable.
 *
 * @param protocol - the protocol whose ALPN to advertise
 */
export const bindServer = async (protocol: BridgeProtocol): Promise<ServerEndpoint> => {
  const { secretKeyBytes } = await loadOrCreateIdentity()
  const builder = Endpoint.builder()
  presetN0(builder)
  builder.secretKey([...secretKeyBytes])
  builder.alpns([alpnFor(protocol)])
  const endpoint = await builder.bind()
  await endpoint.online()
  const ticket = EndpointTicket.fromAddr(endpoint.addr()).toString()
  return { endpoint, nodeId: endpoint.id().toString(), ticket }
}

/** Resolve a `--connect` argument (ticket *or* bare NodeId) to an address. A
 *  ticket carries the home-relay URL; a bare NodeId relies on n0 discovery. */
const resolveTarget = (target: string): EndpointAddr => {
  try {
    return EndpointTicket.fromString(target).endpointAddr()
  } catch {
    return new EndpointAddr(EndpointId.fromString(target), null, [])
  }
}

/**
 * Dial a peer by ticket or NodeId over the protocol's ALPN, using this machine's
 * persistent identity so the remote can recognize (and allowlist) us.
 *
 * @param target - a connection ticket or a bare NodeId
 * @param protocol - the protocol whose ALPN to request
 */
export const dial = async (target: string, protocol: BridgeProtocol): Promise<DialedEndpoint> => {
  const addr = resolveTarget(target)
  const { secretKeyBytes } = await loadOrCreateIdentity()
  const builder = Endpoint.builder()
  presetN0(builder)
  builder.secretKey([...secretKeyBytes])
  const endpoint = await builder.bind()
  await endpoint.online()
  const connection = await endpoint.connect(addr, alpnFor(protocol))
  return { endpoint, connection }
}
