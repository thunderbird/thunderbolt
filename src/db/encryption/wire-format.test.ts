/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { legacyKeyId } from '@shared/e2ee-types'
import { formatWireValue, isEncryptedValue, isV2EncryptedValue, parseWireValue } from './wire-format'

/** A representative legacy v1 value: __enc:<iv-base64>:<ct-base64>, no version, no key_id. */
const v1Value = '__enc:YWJjZGVmZ2hpamtsbW5v:Y2lwaGVydGV4dA=='
/** A representative v2 value: __enc:v2:<key_id>:<iv>:<ct>. */
const v2Value = '__enc:v2:0:YWJjZGVmZ2hpamts:Y2lwaGVydGV4dA=='

describe('isEncryptedValue', () => {
  test('true for v1 and v2, false for plaintext', () => {
    expect(isEncryptedValue(v1Value)).toBe(true)
    expect(isEncryptedValue(v2Value)).toBe(true)
    expect(isEncryptedValue('hello world')).toBe(false)
  })
})

describe('isV2EncryptedValue — the dual-read classifier', () => {
  test('true only for v2', () => {
    expect(isV2EncryptedValue(v2Value)).toBe(true)
    expect(isV2EncryptedValue(v1Value)).toBe(false)
    expect(isV2EncryptedValue('plain')).toBe(false)
  })

  test('a lookalike is not misclassified as v2 (exact "__enc:v2:" prefix required)', () => {
    // A v1 IV is 16 base64 chars, so a v1 value's first segment can never be
    // exactly "v2"; and a value that merely starts with "v2…" is not "v2:".
    expect(isV2EncryptedValue('__enc:v2thing:iv:ct')).toBe(false)
    expect(isV2EncryptedValue('__enc:v20:iv:ct')).toBe(false)
  })
})

describe('parseWireValue', () => {
  test('parses a well-formed v2 value into segments', () => {
    expect(parseWireValue(v2Value)).toEqual({
      version: 'v2',
      keyId: '0',
      iv: 'YWJjZGVmZ2hpamts',
      ciphertext: 'Y2lwaGVydGV4dA==',
    })
  })

  test('parses the reserved "v1" slot — every pre-upgrade row is addressed by it', () => {
    expect(parseWireValue(`__enc:v2:${legacyKeyId}:aXY=:Y3Q=`)?.keyId).toBe(legacyKeyId)
  })

  test('parses every mintable key_id up to the 15-digit bound', () => {
    for (const keyId of ['0', '1', '9', '10', '42', '999999999999999']) {
      expect(parseWireValue(`__enc:v2:${keyId}:aXY=:Y3Q=`)?.keyId).toBe(keyId)
    }
  })

  test('returns null for a key_id outside the grammar — a server-invented label addresses no key', () => {
    // Each of these can only come from the server: bootstrap and /upgrade mint
    // fixed ids, /rotate validates `newPrimaryKey.keyId` against keyIdPattern.
    for (const keyId of [
      'ws1', // a label from no mint path
      '01', // padded — not canonical, would alias "1"
      '1000000000000000', // 16 digits, past the bound
      '1e+21', // exponent notation (THU-871's aliasing primitive)
      '-1',
      '1.0',
      ' 1',
      'V1', // case does not make it the reserved slot
      'x'.repeat(4096), // an unbounded id is an unbounded Map key downstream
    ]) {
      expect(parseWireValue(`__enc:v2:${keyId}:aXY=:Y3Q=`)).toBeNull()
    }
  })

  test('returns null for a legacy v1 value', () => {
    expect(parseWireValue(v1Value)).toBeNull()
  })

  test('returns null for plaintext', () => {
    expect(parseWireValue('nope')).toBeNull()
  })

  test('returns null when segments are missing or malformed', () => {
    expect(parseWireValue('__enc:v2:0')).toBeNull() // no iv/ct
    expect(parseWireValue('__enc:v2::iv:ct')).toBeNull() // empty key_id
    expect(parseWireValue('__enc:v2:0:iv')).toBeNull() // no ct segment
  })
})

describe('formatWireValue', () => {
  test('round-trips with parseWireValue', () => {
    const formatted = formatWireValue('1', 'aXYtYnl0ZXM=', 'Y2lwaGVy')
    expect(formatted).toBe('__enc:v2:1:aXYtYnl0ZXM=:Y2lwaGVy')
    expect(parseWireValue(formatted)).toEqual({
      version: 'v2',
      keyId: '1',
      iv: 'aXYtYnl0ZXM=',
      ciphertext: 'Y2lwaGVy',
    })
  })
})
