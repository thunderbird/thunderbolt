/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A device pairing ticket carries the opaque iroh P2P identity (endpoint id or
 * `EndpointTicket`) that another device scans to bind it into the devices table.
 */
export type PairingTicket = {
  /** Opaque iroh endpoint identity / EndpointTicket string. Treated as a blob — never parsed. */
  nodeId: string
  /** Optional human-friendly device name, shown while pairing. */
  name?: string
}

const pairingScheme = 'thunderbolt-pair'

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const fromBase64Url = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

/**
 * Encode a pairing ticket as a compact, scannable `thunderbolt-pair:<base64url>` string
 * suitable for rendering into a QR code.
 */
export const encodePairingTicket = (ticket: PairingTicket): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(ticket))
  return `${pairingScheme}:${toBase64Url(bytes)}`
}

/**
 * Decode a scanned/pasted pairing string back into a {@link PairingTicket}.
 * Tolerant: a bare endpoint id / iroh ticket (no scheme prefix) is accepted as the node id,
 * so scanning a raw ticket the CLI prints also works. Throws on empty or malformed input.
 */
export const decodePairingTicket = (raw: string): PairingTicket => {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Empty pairing code')
  }

  if (!trimmed.startsWith(`${pairingScheme}:`)) {
    return { nodeId: trimmed }
  }

  const json = new TextDecoder().decode(fromBase64Url(trimmed.slice(pairingScheme.length + 1)))
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Malformed pairing code')
  }

  const record = parsed as Record<string, unknown>
  if (typeof record.nodeId !== 'string' || record.nodeId.length === 0) {
    throw new Error('Pairing code is missing a node ID')
  }

  return typeof record.name === 'string' ? { nodeId: record.nodeId, name: record.name } : { nodeId: record.nodeId }
}
