/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type ParsedIpAddress =
  | { readonly version: 4; readonly value: bigint }
  | { readonly version: 6; readonly value: bigint }

type IpRange = { readonly cidr: string; readonly network: bigint; readonly prefixLength: number }
type ParsedIpv4Address = Extract<ParsedIpAddress, { readonly version: 4 }>

export type EmbeddedIpv4Address = {
  readonly mechanism: 'ipv4-mapped' | 'rfc6052' | 'rfc6145' | '6to4' | 'teredo'
  readonly address: ParsedIpv4Address
}

const blockedIpv4Ranges: readonly IpRange[] = [
  { cidr: '0.0.0.0/8', network: 0x00000000n, prefixLength: 8 }, // current network and unspecified
  { cidr: '10.0.0.0/8', network: 0x0a000000n, prefixLength: 8 }, // private
  { cidr: '100.64.0.0/10', network: 0x64400000n, prefixLength: 10 }, // shared address space
  { cidr: '127.0.0.0/8', network: 0x7f000000n, prefixLength: 8 }, // loopback
  { cidr: '169.254.0.0/16', network: 0xa9fe0000n, prefixLength: 16 }, // link-local
  { cidr: '172.16.0.0/12', network: 0xac100000n, prefixLength: 12 }, // private
  { cidr: '192.0.0.0/24', network: 0xc0000000n, prefixLength: 24 }, // IETF protocol assignments
  { cidr: '192.0.2.0/24', network: 0xc0000200n, prefixLength: 24 }, // documentation
  { cidr: '192.88.99.0/24', network: 0xc0586300n, prefixLength: 24 }, // deprecated 6to4 relay
  { cidr: '192.168.0.0/16', network: 0xc0a80000n, prefixLength: 16 }, // private
  { cidr: '198.18.0.0/15', network: 0xc6120000n, prefixLength: 15 }, // benchmarking
  { cidr: '198.51.100.0/24', network: 0xc6336400n, prefixLength: 24 }, // documentation
  { cidr: '203.0.113.0/24', network: 0xcb007100n, prefixLength: 24 }, // documentation
  { cidr: '224.0.0.0/4', network: 0xe0000000n, prefixLength: 4 }, // multicast
  { cidr: '240.0.0.0/4', network: 0xf0000000n, prefixLength: 4 }, // reserved
]

const blockedIpv6Ranges: readonly IpRange[] = [
  { cidr: '2001::/23', network: 0x20010000000000000000000000000000n, prefixLength: 23 }, // IETF protocol assignments
  { cidr: '2001:db8::/32', network: 0x20010db8000000000000000000000000n, prefixLength: 32 }, // documentation
  { cidr: '2002::/16', network: 0x20020000000000000000000000000000n, prefixLength: 16 }, // deprecated 6to4
  { cidr: '3fff::/20', network: 0x3fff0000000000000000000000000000n, prefixLength: 20 }, // documentation
]

/** Exact CIDR policy applied in addition to blanket non-global-unicast IPv6 rejection. */
export const privateOrInternalAddressCidrs = Object.freeze({
  ipv4: Object.freeze(blockedIpv4Ranges.map(({ cidr }) => cidr)),
  ipv6: Object.freeze(blockedIpv6Ranges.map(({ cidr }) => cidr)),
})

const ipv4Mask = 0xffffffffn
const ipv4MappedNetwork = 0x00000000000000000000ffff00000000n
const rfc6052Network = 0x0064ff9b000000000000000000000000n
const rfc6145Network = 0x0000000000000000ffff000000000000n
const sixToFourNetwork = 0x20020000000000000000000000000000n
const teredoNetwork = 0x20010000000000000000000000000000n

/** Parse canonical dotted-decimal IPv4 into a 32-bit integer. */
const parseIpv4 = (address: string): bigint | undefined => {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined
  const bytes = parts.map(Number)
  if (bytes.some((byte) => byte > 255)) return undefined
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
}

/** Parse compressed or full IPv6 into a 128-bit integer. */
const parseIpv6 = (address: string): bigint | undefined => {
  const hasOpeningBracket = address.startsWith('[')
  const hasClosingBracket = address.endsWith(']')
  if (hasOpeningBracket !== hasClosingBracket) return undefined
  const unwrappedAddress = hasOpeningBracket ? address.slice(1, -1) : address
  const normalizedAddress = unwrappedAddress.split('%')[0]
  if (normalizedAddress === undefined || !normalizedAddress.includes(':')) return undefined
  const dottedTail = normalizedAddress.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  const ipv4Tail = dottedTail ? parseIpv4(dottedTail) : undefined
  if (dottedTail && ipv4Tail === undefined) return undefined
  const expandedAddress =
    dottedTail && ipv4Tail !== undefined
      ? normalizedAddress.replace(dottedTail, `${(ipv4Tail >> 16n).toString(16)}:${(ipv4Tail & 0xffffn).toString(16)}`)
      : normalizedAddress
  if ((expandedAddress.match(/::/g) ?? []).length > 1) return undefined

  const [left = '', right] = expandedAddress.split('::')
  const leftGroups = left ? left.split(':') : []
  const rightGroups = right ? right.split(':') : []
  const missingGroups = 8 - leftGroups.length - rightGroups.length
  if ((right === undefined && missingGroups !== 0) || (right !== undefined && missingGroups < 1)) return undefined

  const groups = [...leftGroups, ...Array.from({ length: missingGroups }, () => '0'), ...rightGroups]
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/i.test(group))) return undefined
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n)
}

/** Parse an IP literal while leaving domain names unresolved. */
export const parseIpAddress = (address: string): ParsedIpAddress | undefined => {
  const ipv4 = parseIpv4(address)
  if (ipv4 !== undefined) return { version: 4, value: ipv4 }
  const ipv6 = parseIpv6(address)
  return ipv6 === undefined ? undefined : { version: 6, value: ipv6 }
}

/** Test an integer IP address against a CIDR prefix. */
const isInCidr = (value: bigint, network: bigint, prefixLength: number, addressBits: number): boolean => {
  const shift = BigInt(addressBits - prefixLength)
  return value >> shift === network >> shift
}

/** Extract IPv4 embedded by an IPv6 mapping or transition mechanism. */
export const extractEmbeddedIpv4Address = (address: ParsedIpAddress): EmbeddedIpv4Address | undefined => {
  if (address.version === 4) return undefined
  const ipv6Value = address.value
  if (typeof ipv6Value !== 'bigint') return undefined
  if (isInCidr(ipv6Value, ipv4MappedNetwork, 96, 128)) {
    return { mechanism: 'ipv4-mapped', address: { version: 4, value: ipv6Value & ipv4Mask } }
  }
  if (isInCidr(ipv6Value, rfc6052Network, 96, 128)) {
    return { mechanism: 'rfc6052', address: { version: 4, value: ipv6Value & ipv4Mask } }
  }
  if (isInCidr(ipv6Value, rfc6145Network, 96, 128)) {
    return { mechanism: 'rfc6145', address: { version: 4, value: ipv6Value & ipv4Mask } }
  }
  if (isInCidr(ipv6Value, sixToFourNetwork, 16, 128)) {
    return { mechanism: '6to4', address: { version: 4, value: (ipv6Value >> 80n) & ipv4Mask } }
  }
  if (isInCidr(ipv6Value, teredoNetwork, 32, 128)) {
    return { mechanism: 'teredo', address: { version: 4, value: (ipv6Value & ipv4Mask) ^ ipv4Mask } }
  }
  return undefined
}

/** Reject non-public IPv4 and IPv6 address space, including IPv4 embeddings. */
export const isPrivateOrInternalAddress = (address: ParsedIpAddress): boolean => {
  if (address.version === 4) {
    return blockedIpv4Ranges.some(({ network, prefixLength }) => isInCidr(address.value, network, prefixLength, 32))
  }

  const embeddedIpv4 = extractEmbeddedIpv4Address(address)
  if (embeddedIpv4?.mechanism === 'ipv4-mapped') return isPrivateOrInternalAddress(embeddedIpv4.address)
  if (embeddedIpv4 && isPrivateOrInternalAddress(embeddedIpv4.address)) return true

  const isGlobalUnicast = isInCidr(address.value, 0x20000000000000000000000000000000n, 3, 128)
  if (!isGlobalUnicast) return true
  return blockedIpv6Ranges.some(({ network, prefixLength }) => isInCidr(address.value, network, prefixLength, 128))
}
