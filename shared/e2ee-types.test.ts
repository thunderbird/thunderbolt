/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  canaryAAD,
  challengeOperations,
  ecdsaKeyAlgorithm,
  ecdsaSignAlgorithm,
  encodeAAD,
  encodeChallengePayload,
  encPrefix,
  encV2Prefix,
  initialKeyId,
  isMintableKeyId,
  kdfIterations,
  legacyKeyId,
  payloadSeparator,
} from './e2ee-types'

/**
 * These bytes ARE the frontend↔backend contract: the AAD bound into every v2
 * AES-GCM operation and the challenge payload signed on one side and verified on
 * the other. A silent change to the separator, field order, or UTF-8 encoding
 * makes challenge-response never verify and every cross-device decrypt fail — so
 * they are pinned to exact byte arrays here, not just round-tripped.
 */
describe('e2ee wire/AAD constants', () => {
  test('separator is a single U+001F (unit separator)', () => {
    expect(payloadSeparator.length).toBe(1)
    expect(payloadSeparator.charCodeAt(0)).toBe(0x1f)
  })

  test('prefixes and reserved key ids are stable', () => {
    expect(encPrefix).toBe('__enc:')
    expect(encV2Prefix).toBe('__enc:v2:')
    expect(initialKeyId).toBe('0')
    expect(legacyKeyId).toBe('v1')
  })

  test('challenge operations are the frozen set (exact order pins additions/removals)', () => {
    expect([...challengeOperations] as string[]).toEqual(['approve', 'deny', 'revoke', 'rotate', 'recover', 'upgrade'])
  })

  test('crypto algorithm params are pinned', () => {
    expect(ecdsaKeyAlgorithm).toEqual({ name: 'ECDSA', namedCurve: 'P-256' })
    expect(ecdsaSignAlgorithm).toEqual({ name: 'ECDSA', hash: 'SHA-256' })
    expect(kdfIterations).toBe(600_000)
  })
})

/**
 * The grammar is the whole fix for the THU-871 mint collision, so its boundary
 * is pinned numerically rather than by example: 15 digits must pass and 16 must
 * fail, because 15 digits is the largest width that keeps `max + 1` exact under
 * IEEE-754 and out of exponent notation.
 */
describe('isMintableKeyId (THU-871 key_id grammar)', () => {
  test('accepts the unpadded decimal counter, up to 15 digits', () => {
    for (const keyId of [initialKeyId, '1', '9', '10', '12345', '9'.repeat(15)]) {
      expect(isMintableKeyId(keyId)).toBe(true)
    }
  })

  test('rejects widths where the allocation arithmetic stops being exact', () => {
    // 16 digits can exceed 2^53; 17 makes `max + 1 === max`; 1e21+ stringifies
    // to exponent notation, which used to pass the `^[^:]+$` wire check.
    for (const keyId of ['1'.repeat(16), '1'.repeat(17), '1'.repeat(21), '1e+21', '1e+64']) {
      expect(isMintableKeyId(keyId)).toBe(false)
    }
  })

  test('a 17-digit id really does defeat unfiltered max+1 — the bug this grammar closes', () => {
    const planted = '10000000000000000'
    expect(String(Number.parseInt(planted, 10) + 1)).toBe(planted)
    expect(isMintableKeyId(planted)).toBe(false)
  })

  test('rejects non-canonical, signed, padded and non-numeric forms', () => {
    for (const keyId of ['', ' ', '01', '007', '-1', '+1', '1.0', ' 1', '1 ', '0x10', 'ws1', 'poison-1', '1:2']) {
      expect(isMintableKeyId(keyId)).toBe(false)
    }
  })

  test('the reserved legacy slot is deliberately NOT mintable — only /encryption/upgrade writes it', () => {
    expect(isMintableKeyId(legacyKeyId)).toBe(false)
  })
})

describe('encodeAAD', () => {
  test('pins exact bytes for a representative row', () => {
    expect(Array.from(encodeAAD('chat_messages', 'content', 'row-123', '0'))).toEqual([
      99, 104, 97, 116, 95, 109, 101, 115, 115, 97, 103, 101, 115, 31, 99, 111, 110, 116, 101, 110, 116, 31, 114, 111,
      119, 45, 49, 50, 51, 31, 48,
    ])
  })

  test('key_id is bound — different key_id yields different AAD', () => {
    const a = Array.from(encodeAAD('t', 'c', 'r', '0'))
    const b = Array.from(encodeAAD('t', 'c', 'r', '1'))
    expect(a).not.toEqual(b)
  })

  test('field boundaries are unambiguous (no cross-field collision)', () => {
    // "ab|c" vs "a|bc" must differ despite equal concatenation without a separator.
    expect(Array.from(encodeAAD('ab', 'c', 'r', '0'))).not.toEqual(Array.from(encodeAAD('a', 'bc', 'r', '0')))
  })
})

describe('canaryAAD', () => {
  test('pins the fixed __meta/canary tuple bytes', () => {
    expect(Array.from(canaryAAD('user-1', '0'))).toEqual([
      95, 95, 109, 101, 116, 97, 31, 99, 97, 110, 97, 114, 121, 31, 117, 115, 101, 114, 45, 49, 31, 48,
    ])
  })

  test('equals encodeAAD with the synthetic tuple', () => {
    expect(Array.from(canaryAAD('u', 'v1'))).toEqual(Array.from(encodeAAD('__meta', 'canary', 'u', 'v1')))
  })
})

describe('encodeChallengePayload', () => {
  test('pins exact bytes for a representative challenge', () => {
    expect(Array.from(encodeChallengePayload('nonce-x', 'rotate', 'dev-9'))).toEqual([
      110, 111, 110, 99, 101, 45, 120, 31, 114, 111, 116, 97, 116, 101, 31, 100, 101, 118, 45, 57,
    ])
  })

  test('operation is bound — different op yields different payload', () => {
    expect(Array.from(encodeChallengePayload('n', 'approve', 'd'))).not.toEqual(
      Array.from(encodeChallengePayload('n', 'revoke', 'd')),
    )
  })
})
