/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  createApprovalCodeContext,
  createApprovalCodeOptions,
  createApprovalCommitment,
  createApprovalNonce,
  createApprovalSessionId,
  deriveApprovalCode,
  matchesApprovalCode,
} from './device-approval-code'
import { exportMlKemPublicKey, exportPublicKey, generateKeyPair, generateMlKemKeyPair } from './primitives'

const anchor = {
  userId: 'account-1',
  deviceId: 'device-1',
  ecdhPublicKey: 'BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfU=',
  mlkemPublicKey: exportMlKemPublicKey(new Uint8Array(1184)),
}
const sessionId = '00112233445566778899aabbccddeeff'
const challenge = 'a'.repeat(64)
const reveal = 'b'.repeat(64)
const challengerDeviceId = 'trusted-device-1'

const honestConfirmation = async () => {
  const context = await createApprovalCodeContext(anchor, sessionId)
  return {
    sessionId,
    commitment: await createApprovalCommitment(context, reveal),
    challenge,
    reveal,
    code: await deriveApprovalCode(context, challengerDeviceId, challenge, reveal),
  }
}

describe('device approval code', () => {
  it('creates hex session ids and nonces of the wire length', () => {
    expect(createApprovalSessionId()).toMatch(/^[0-9a-f]{32}$/)
    expect(createApprovalNonce()).toMatch(/^[0-9a-f]{64}$/)
    expect(createApprovalNonce()).not.toBe(createApprovalNonce())
  })

  it('matches the independently SHA-256-derived golden vector', async () => {
    const context = await createApprovalCodeContext(anchor, sessionId)
    expect(await createApprovalCommitment(context, reveal)).toBe(
      '2fcddd2a1724489f2020f39136db55a032995ed041ff4892dbea56b271fed086',
    )
    expect(await deriveApprovalCode(context, challengerDeviceId, challenge, reveal)).toBe('65')
  })

  it('binds every input independently', async () => {
    const otherEcdh = await exportPublicKey((await generateKeyPair()).publicKey)
    const otherMlkem = exportMlKemPublicKey(generateMlKemKeyPair().publicKey)
    const context = await createApprovalCodeContext(anchor, sessionId)
    const code = await deriveApprovalCode(context, challengerDeviceId, challenge, reveal)
    const contexts = [
      await createApprovalCodeContext({ ...anchor, userId: 'account-2' }, sessionId),
      await createApprovalCodeContext({ ...anchor, deviceId: 'device-2' }, sessionId),
      await createApprovalCodeContext({ ...anchor, ecdhPublicKey: otherEcdh }, sessionId),
      await createApprovalCodeContext({ ...anchor, mlkemPublicKey: otherMlkem }, sessionId),
      await createApprovalCodeContext(anchor, 'ffeeddccbbaa99887766554433221100'),
    ]
    for (const changed of contexts) {
      expect(changed).not.toBe(context)
      expect(await createApprovalCommitment(changed, reveal)).not.toBe(await createApprovalCommitment(context, reveal))
    }
    // Two digits collide by chance one time in a hundred, so the commitment above compares full digests.
    // The code-only inputs get a spot check with fixed values that are known not to collide.
    const variants = [
      await deriveApprovalCode(context, 'trusted-device-2', challenge, reveal),
      await deriveApprovalCode(context, challengerDeviceId, 'c'.repeat(64), reveal),
      await deriveApprovalCode(context, challengerDeviceId, challenge, 'd'.repeat(64)),
    ]
    expect(variants.filter((variant) => variant === code)).toHaveLength(0)
  })

  it('canonicalises whitespace in served keys', async () => {
    const padded = {
      ...anchor,
      ecdhPublicKey: ` ${anchor.ecdhPublicKey}\n`,
      mlkemPublicKey: `${anchor.mlkemPublicKey} `,
    }
    expect(await createApprovalCodeContext(padded, sessionId)).toBe(await createApprovalCodeContext(anchor, sessionId))
  })

  it('verifies an honest confirmation and rejects every tampered field', async () => {
    const confirmation = await honestConfirmation()
    const otherEcdh = await exportPublicKey((await generateKeyPair()).publicKey)
    const wrongCode = confirmation.code === '01' ? '02' : '01'
    expect(await matchesApprovalCode(anchor, confirmation, challengerDeviceId)).toBe(true)
    expect(await matchesApprovalCode(anchor, { ...confirmation, code: wrongCode }, challengerDeviceId)).toBe(false)
    expect(await matchesApprovalCode(anchor, { ...confirmation, commitment: 'e'.repeat(64) }, challengerDeviceId)).toBe(
      false,
    )
    expect(await matchesApprovalCode({ ...anchor, ecdhPublicKey: otherEcdh }, confirmation, challengerDeviceId)).toBe(
      false,
    )
    expect(await matchesApprovalCode(anchor, confirmation, 'trusted-device-2')).toBe(false)
  })

  it('offers the code among six distinct two-digit options in a random position', () => {
    const positions = new Set<number>()
    for (let run = 0; run < 200; run += 1) {
      const options = createApprovalCodeOptions('07')
      expect(options).toHaveLength(6)
      expect(new Set(options).size).toBe(6)
      expect(options.every((option) => /^\d{2}$/.test(option))).toBe(true)
      positions.add(options.indexOf('07'))
    }
    expect([...positions].sort()).toEqual([0, 1, 2, 3, 4, 5])
  })
})
