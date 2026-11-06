/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * iroh endpoint helpers: bind a server (agent host) or dial a peer (controller),
 * both pinned to this machine's persistent identity and speaking one ALPN.
 *
 * Transport shape (verified against the n0 relays):
 *   builder → configureTransport (n0 preset: relays + discovery + crypto, with
 *   the relay optionally overridden via THUNDERBOLT_IROH_RELAY_URL) → secretKey
 *   (stable NodeId) → [server only] alpns → bind → online (home relay ready).
 * A connection ticket embeds the NodeId + home-relay URL, so it is the natural
 * out-of-band pairing primitive; a bare NodeId also dials via n0 DNS discovery.
 */

import { Endpoint, EndpointAddr, EndpointId, EndpointTicket, RelayMode, presetN0 } from '@number0/iroh'
import type { Connection, EndpointBuilder } from '@number0/iroh'
import { irohAlpnFor } from '../../../shared/iroh.ts'
import type { BridgeProtocol } from '../agent/types.ts'
import { loadOrCreateIdentity } from './identity.ts'

/** Env var that overrides the iroh relay. Unset/empty keeps the n0 public relays
 *  (today's behavior); set it to a self-hosted iroh-relay wss URL to switch with
 *  no code change. Read at runtime, so the CLI binary needs no rebuild. */
const relayUrlEnv = 'THUNDERBOLT_IROH_RELAY_URL'

/** The self-hosted relay override from {@link relayUrlEnv}, or `undefined` to
 *  keep the n0 public relays. Whitespace-only is treated as unset, so an exported
 *  but blank var is byte-for-byte the default. */
export const relayUrlOverride = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const url = env[relayUrlEnv]?.trim()
  return url ? url : undefined
}

/** The two @number0/iroh calls {@link configureTransport} makes, behind a seam so
 *  a test can pass a fake builder and assert the relay override is threaded
 *  through without binding a native endpoint. Defaults to the real SDK. */
export type TransportConfigurator = {
  readonly applyPreset: (builder: EndpointBuilder) => void
  readonly customRelayMode: (urls: string[]) => RelayMode
}

const defaultConfigurator: TransportConfigurator = {
  applyPreset: presetN0,
  customRelayMode: (urls) => RelayMode.customFromUrls(urls),
}

/**
 * Apply the n0 transport preset (relays + n0 DNS discovery + crypto), then — only
 * when {@link relayUrlEnv} is set — swap ONLY the relay for that self-hosted
 * URL. n0 DNS discovery + crypto stay intact, so a bare NodeId still resolves and
 * tickets still dial; only the relay hop changes. Unset/empty env leaves the n0
 * default untouched (zero regression to the proven flows).
 *
 * @param builder - the endpoint builder to configure in place
 * @param configurator - test seam; production uses the real @number0/iroh SDK
 */
export const configureTransport = (
  builder: EndpointBuilder,
  configurator: TransportConfigurator = defaultConfigurator,
): void => {
  configurator.applyPreset(builder)
  const relayUrl = relayUrlOverride()
  if (relayUrl) {
    builder.relayMode(configurator.customRelayMode([relayUrl]))
  }
}

/** Per-protocol ALPN: one string per protocol version. Both peers must match or
 *  the handshake is refused — so an ACP client can't drive an MCP bridge (or
 *  vice-versa). Each bridge protocol also binds a distinct identity (distinct
 *  NodeId), so the separation holds even when a stale address resolves the
 *  wrong-protocol process, not just at the ALPN check. */
/** The protocol's ALPN as the byte array the iroh API expects. */
export const alpnFor = (protocol: BridgeProtocol): number[] => Array.from(Buffer.from(irohAlpnFor(protocol), 'utf8'))

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
 * Bind a server endpoint on this protocol's persistent identity, advertising the
 * protocol's ALPN, and wait until a home relay is usable so the returned ticket
 * is dialable. Each protocol loads a distinct identity, so the acp and mcp
 * bridges publish distinct NodeIds and a ticket can only reach its own bridge.
 *
 * @param protocol - the protocol whose identity to pin and ALPN to advertise
 */
export const bindServer = async (protocol: BridgeProtocol): Promise<ServerEndpoint> => {
  const { secretKeyBytes } = await loadOrCreateIdentity(protocol)
  const builder = Endpoint.builder()
  configureTransport(builder)
  builder.secretKey([...secretKeyBytes])
  builder.alpns([alpnFor(protocol)])
  const endpoint = await builder.bind()
  await endpoint.online()
  const ticket = EndpointTicket.fromAddr(endpoint.addr()).toString()
  return { endpoint, nodeId: endpoint.id().toString(), ticket }
}

/** Resolve a `--connect` argument (ticket *or* bare NodeId) to an address. A
 *  ticket carries the home-relay URL; a bare NodeId relies on n0 discovery. */
export const resolveTarget = (target: string): EndpointAddr => {
  try {
    return EndpointTicket.fromString(target).endpointAddr()
  } catch {
    return new EndpointAddr(EndpointId.fromString(target), null, [])
  }
}

/**
 * Dial a peer by ticket or NodeId over the protocol's ALPN, using this machine's
 * stable client identity so the remote can recognize (and allowlist) us. The
 * dialer NodeId stays on the legacy `acp` identity regardless of the dialed
 * protocol — it is the single client NodeId a remote bridge allowlists, so it
 * must not fork per-protocol (only the bridge accept-side is per-protocol).
 *
 * @param target - a connection ticket or a bare NodeId
 * @param protocol - the protocol whose ALPN to request
 */
export const dial = async (target: string, protocol: BridgeProtocol): Promise<DialedEndpoint> => {
  const addr = resolveTarget(target)
  const { secretKeyBytes } = await loadOrCreateIdentity('acp')
  const builder = Endpoint.builder()
  configureTransport(builder)
  builder.secretKey([...secretKeyBytes])
  const endpoint = await builder.bind()
  await endpoint.online()
  const connection = await endpoint.connect(addr, alpnFor(protocol))
  return { endpoint, connection }
}
