/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestSettings } from '@/test-utils/settings'
import { describe, expect, it } from 'bun:test'
import { fingerprintPublicKey, getOrgEscrowKey } from './org-escrow'

const generateP256Raw = async (): Promise<Uint8Array> => {
  const { publicKey } = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
}

describe('fingerprintPublicKey', () => {
  it('is base64(SHA-256(raw bytes)) — a known vector, not a self-referential call', () => {
    // Independently derived: printf '\x04' | openssl dgst -sha256 -binary | openssl base64
    expect(fingerprintPublicKey(new Uint8Array([0x04]))).toBe('5S2cUIxQI0c0TYwHrZHL1gaK/HX/YpLwYqCco4HInnE=')
  })

  it('changes when a single key byte changes', async () => {
    const raw = await generateP256Raw()
    const tampered = new Uint8Array(raw)
    tampered[raw.length - 1] ^= 0x01
    expect(fingerprintPublicKey(tampered)).not.toBe(fingerprintPublicKey(raw))
  })
})

describe('getOrgEscrowKey', () => {
  it('returns null when escrow is disabled', () => {
    expect(getOrgEscrowKey(createTestSettings({ orgKmsEscrowEnabled: false }))).toBeNull()
  })

  it('returns the configured key with its fingerprint', async () => {
    const publicKey = Buffer.from(await generateP256Raw()).toString('base64')

    const escrowKey = getOrgEscrowKey(
      createTestSettings({ orgKmsEscrowEnabled: true, orgKmsEscrowStaticPublicKey: publicKey }),
    )

    expect(escrowKey?.publicKey).toBe(publicKey)
    expect(escrowKey?.fingerprint).toBe(fingerprintPublicKey(Buffer.from(publicKey, 'base64')))
  })
})
