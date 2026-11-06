/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  createDeviceApprovalFingerprint,
  matchesDeviceApprovalFingerprint,
  normalizeDeviceApprovalFingerprint,
} from './device-approval-fingerprint'
import { exportMlKemPublicKey, exportPublicKey, generateKeyPair, generateMlKemKeyPair } from './primitives'

const anchor = {
  userId: 'account-1',
  deviceId: 'device-1',
  ecdhPublicKey: 'BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=',
  mlkemPublicKey: exportMlKemPublicKey(new Uint8Array(1184)),
}
const fingerprint = 'FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680-CD9B-98EE-0A09-C5B4-A48D-212E-295B-CA2C'

describe('device approval fingerprint', () => {
  it('rejects a truncated 32-hex-character fingerprint', async () => {
    const truncatedFingerprint = 'FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680'
    expect(normalizeDeviceApprovalFingerprint(truncatedFingerprint)).toBe('')
    expect(await matchesDeviceApprovalFingerprint(anchor, truncatedFingerprint)).toBe(false)
  })
  it('matches the independently SHA-256-derived v1 golden vector', async () => {
    expect(await createDeviceApprovalFingerprint(anchor)).toBe(fingerprint)
  })

  it('rejects a full fingerprint differing only in its final hex digit', async () => {
    const changedFingerprint = 'FEDC-44EB-4612-7C84-EADF-4C47-B0A8-4680-CD9B-98EE-0A09-C5B4-A48D-212E-295B-CA2D'
    expect(normalizeDeviceApprovalFingerprint(changedFingerprint)).toHaveLength(64)
    expect(await matchesDeviceApprovalFingerprint(anchor, changedFingerprint)).toBe(false)
  })

  it('binds each account, device, and public key independently', async () => {
    const otherEcdh = await exportPublicKey((await generateKeyPair()).publicKey)
    const otherMlkem = exportMlKemPublicKey(generateMlKemKeyPair().publicKey)
    for (const changed of [
      { userId: 'account-2' },
      { deviceId: 'device-2' },
      { ecdhPublicKey: otherEcdh },
      { mlkemPublicKey: otherMlkem },
    ]) {
      expect(await matchesDeviceApprovalFingerprint({ ...anchor, ...changed }, fingerprint)).toBe(false)
    }
  })

  it('canonicalizes equivalent base64 key encodings', async () => {
    expect(
      await createDeviceApprovalFingerprint({
        ...anchor,
        ecdhPublicKey: anchor.ecdhPublicKey.replace(/=+$/, ''),
        mlkemPublicKey: ` ${anchor.mlkemPublicKey}\n`,
      }),
    ).toBe(fingerprint)
  })

  it('accepts only case, ASCII spaces and hyphens as fingerprint formatting', async () => {
    expect(await matchesDeviceApprovalFingerprint(anchor, fingerprint.toLowerCase().replaceAll('-', ' '))).toBe(true)
    expect(normalizeDeviceApprovalFingerprint(fingerprint)).toBe(
      'FEDC44EB46127C84EADF4C47B0A84680CD9B98EE0A09C5B4A48D212E295BCA2C',
    )
    for (const invalid of [
      '',
      `${fingerprint}0`,
      fingerprint.slice(1),
      fingerprint.replace('-', '\t'),
      fingerprint.replace('F', 'Ｇ'),
    ]) {
      expect(await matchesDeviceApprovalFingerprint(anchor, invalid)).toBe(false)
    }
  })

  it('rejects malformed P-256 and unusable ML-KEM keys before producing a code', async () => {
    await expect(createDeviceApprovalFingerprint({ ...anchor, ecdhPublicKey: 'AAAA' })).rejects.toThrow()
    await expect(createDeviceApprovalFingerprint({ ...anchor, mlkemPublicKey: 'AAAA' })).rejects.toThrow()
    const invalidModulus = new Uint8Array(1184).fill(255)
    await expect(
      createDeviceApprovalFingerprint({ ...anchor, mlkemPublicKey: exportMlKemPublicKey(invalidModulus) }),
    ).rejects.toThrow()
  })
})
