/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  extractEmbeddedIpv4Address,
  isPrivateOrInternalAddress,
  parseIpAddress,
  privateOrInternalAddressCidrs,
} from './ip-classification.ts'

/** Parse one test IP literal. */
const parseLiteral = (address: string) => {
  const parsedAddress = parseIpAddress(address)
  if (!parsedAddress) throw new Error(`Expected an IP literal: ${address}`)
  return parsedAddress
}

/** Parse and classify one test IP literal. */
const classify = (address: string): boolean => isPrivateOrInternalAddress(parseLiteral(address))

/** Parse one test IPv4 literal. */
const parseIpv4Literal = (address: string) => {
  const parsedAddress = parseLiteral(address)
  if (parsedAddress.version !== 4) throw new Error(`Expected an IPv4 literal: ${address}`)
  return parsedAddress
}

const blockedIpv4Cidrs = [
  ['0.0.0.0/8', '0.0.0.0', '0.255.255.255'],
  ['10.0.0.0/8', '10.0.0.0', '10.255.255.255'],
  ['100.64.0.0/10', '100.64.0.0', '100.127.255.255'],
  ['127.0.0.0/8', '127.0.0.0', '127.255.255.255'],
  ['169.254.0.0/16', '169.254.0.0', '169.254.255.255'],
  ['172.16.0.0/12', '172.16.0.0', '172.31.255.255'],
  ['192.0.0.0/24', '192.0.0.0', '192.0.0.255'],
  ['192.0.2.0/24', '192.0.2.0', '192.0.2.255'],
  ['192.88.99.0/24', '192.88.99.0', '192.88.99.255'],
  ['192.168.0.0/16', '192.168.0.0', '192.168.255.255'],
  ['198.18.0.0/15', '198.18.0.0', '198.19.255.255'],
  ['198.51.100.0/24', '198.51.100.0', '198.51.100.255'],
  ['203.0.113.0/24', '203.0.113.0', '203.0.113.255'],
  ['224.0.0.0/4', '224.0.0.0', '239.255.255.255'],
  ['240.0.0.0/4', '240.0.0.0', '255.255.255.255'],
] as const

const allowedIpv4Boundaries = [
  ['1.0.0.0'],
  ['9.255.255.255'],
  ['11.0.0.0'],
  ['100.63.255.255'],
  ['100.128.0.0'],
  ['126.255.255.255'],
  ['128.0.0.0'],
  ['169.253.255.255'],
  ['169.255.0.0'],
  ['172.15.255.255'],
  ['172.32.0.0'],
  ['191.255.255.255'],
  ['192.0.1.255'],
  ['192.0.3.0'],
  ['192.88.98.255'],
  ['192.88.100.0'],
  ['192.167.255.255'],
  ['192.169.0.0'],
  ['198.17.255.255'],
  ['198.20.0.0'],
  ['198.51.99.255'],
  ['198.51.101.0'],
  ['203.0.112.255'],
  ['203.0.114.0'],
  ['223.255.255.255'],
] as const

const blockedIpv6Cidrs = [
  ['2001::/23', '2001::', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:db8::/32', '2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2002::/16', '2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['3fff::/20', '3fff::', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
] as const

const allowedIpv6Boundaries = [
  ['2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:200::'],
  ['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:db9::'],
  ['2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2003::'],
  ['3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['3fff:1000::'],
] as const

describe('IP literal parsing', () => {
  test.each([
    ['192.0.2.1', 4],
    ['2001:db8::1', 6],
    ['[2001:db8::1]', 6],
    ['fe80::1%en0', 6],
    ['::ffff:192.0.2.1', 6],
  ] as const)('parses %s as IPv%s', (literal, version) => {
    expect(parseIpAddress(literal)?.version).toBe(version)
  })

  test.each(['example.com', '', '1.2.3', '256.0.0.1', '2001::db8::1', '2001:db8::zzzz'])('rejects %s', (value) => {
    expect(parseIpAddress(value)).toBeUndefined()
  })

  test.each([
    ['1.2.3.', 'empty IPv4 segment'],
    ['1..2.3', 'empty IPv4 segment'],
    ['1,2.3.4', 'bad IPv4 separator'],
    ['1234.2.3.4', 'overlong IPv4 part'],
    ['1.2.3.4.5', 'overlong IPv4 part list'],
    ['2001:db8:0:0:0:0:1', 'truncated IPv6 group list'],
    ['2001:db8:0:0:0:0:1:', 'empty IPv6 segment'],
    ['2001-db8::1', 'bad IPv6 separator'],
    ['[2001:db8::1', 'missing closing IPv6 bracket'],
    ['2001:db8::1]', 'missing opening IPv6 bracket'],
    ['2001:db8:00000::1', 'overlong IPv6 group'],
    ['1:2:3:4:5:6:7:8:9', 'overlong IPv6 group list'],
    ['::ffff:192.0.2', 'truncated embedded IPv4 tail'],
    ['::ffff:192..2.1', 'empty embedded IPv4 segment'],
    ['::ffff:192-0.2.1', 'bad embedded IPv4 separator'],
    ['::ffff:192.0.2.1000', 'overlong embedded IPv4 part'],
    ['::ffff:192.0.2.1.5', 'overlong embedded IPv4 part list'],
  ] as const)('rejects %s (%s)', (value) => {
    expect(parseIpAddress(value)).toBeUndefined()
  })
})

describe('private and internal IP classification', () => {
  test('pins the exact CIDR policy', () => {
    expect(privateOrInternalAddressCidrs).toEqual({
      ipv4: blockedIpv4Cidrs.map(([cidr]) => cidr),
      ipv6: blockedIpv6Cidrs.map(([cidr]) => cidr),
    })
  })

  test.each(blockedIpv4Cidrs)('blocks exact IPv4 CIDR %s from %s through %s', (_cidr, first, last) => {
    expect(classify(first)).toBe(true)
    expect(classify(last)).toBe(true)
  })

  test.each(allowedIpv4Boundaries)('allows public IPv4 boundary %s', (address) => {
    expect(classify(address)).toBe(false)
  })

  test.each(blockedIpv6Cidrs)('blocks exact IPv6 CIDR %s from %s through %s', (_cidr, first, last) => {
    expect(classify(first)).toBe(true)
    expect(classify(last)).toBe(true)
  })

  test.each(allowedIpv6Boundaries)('allows global-unicast IPv6 boundary %s', (address) => {
    expect(classify(address)).toBe(false)
  })

  test.each(['::', '::1', '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '4000::', 'fc00::1', 'fe80::1'])(
    'blocks non-global-unicast IPv6 %s',
    (address) => {
      expect(classify(address)).toBe(true)
    },
  )

  test.each([
    ['IPv4-mapped', 'ipv4-mapped', '::ffff:127.0.0.1', '127.0.0.1', true, '::ffff:8.8.8.8', '8.8.8.8', false],
    ['RFC 6052', 'rfc6052', '64:ff9b::7f00:1', '127.0.0.1', true, '64:ff9b::808:808', '8.8.8.8', true],
    ['RFC 6145', 'rfc6145', '::ffff:0:7f00:1', '127.0.0.1', true, '::ffff:0:808:808', '8.8.8.8', true],
    ['6to4', '6to4', '2002:7f00:1::', '127.0.0.1', true, '2002:808:808::', '8.8.8.8', true],
    ['Teredo', 'teredo', '2001:0:0:0:0:0:80ff:fffe', '127.0.0.1', true, '2001:0:0:0:0:0:f7f7:f7f7', '8.8.8.8', true],
  ] as const)(
    '%s extracts and classifies private and public IPv4 embeddings',
    (_label, mechanism, privateAddress, privateIpv4, privateResult, publicAddress, publicIpv4, publicResult) => {
      expect(extractEmbeddedIpv4Address(parseLiteral(privateAddress))).toEqual({
        mechanism,
        address: parseIpv4Literal(privateIpv4),
      })
      expect(extractEmbeddedIpv4Address(parseLiteral(publicAddress))).toEqual({
        mechanism,
        address: parseIpv4Literal(publicIpv4),
      })
      expect(classify(privateAddress)).toBe(privateResult)
      expect(classify(publicAddress)).toBe(publicResult)
    },
  )
})
