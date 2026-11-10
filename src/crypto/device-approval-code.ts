/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Short approval code by commit-then-reveal (a short authentication string, as in Bluetooth
 * Numeric Comparison). The new device commits to its secret before it sees the trusted device's
 * challenge, so a relaying server cannot pick keys that make both screens show the same code:
 * it gets one guess in a hundred per attempt and nothing to grind offline. Two digits (00 to 99)
 * keep the comparison easy; the per-device attempt limit bounds the rest.
 */

import type { DeviceAnchor } from './canary'
import { canonicalizeDeviceAnchor } from './device-approval-fingerprint'

const approvalCodeLength = 2

/** Codes the trusted device offers: a careless tap still hits the real one only one time in six. */
const approvalCodeOptionCount = 6

/** The trusted device's frozen view of one attempt, re-verified by `approveDevice` before any key work. */
export type ApprovalCodeConfirmation = {
  sessionId: string
  commitment: string
  challenge: string
  reveal: string
  code: string
}

const codeModulus = 10 ** approvalCodeLength

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const randomHex = (byteLength: number): string => toHex(crypto.getRandomValues(new Uint8Array(byteLength)))

const sha256Hex = async (value: string): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))

/** Uniform integer in [0, bound) from the platform CSPRNG; rejection sampling avoids modulo bias. */
const randomBelow = (bound: number): number => {
  const limit = 2 ** 32 - (2 ** 32 % bound)
  const [value] = crypto.getRandomValues(new Uint32Array(1))
  return value < limit ? value % bound : randomBelow(bound)
}

/** Random 16-byte session id, lowercase hex. */
export const createApprovalSessionId = (): string => randomHex(16)

/** Random 32-byte challenge or reveal, lowercase hex. */
export const createApprovalNonce = (): string => randomHex(32)

/** The value both devices hash: protocol labels, the canonical key tuple, and the session. */
export const createApprovalCodeContext = async (anchor: DeviceAnchor, sessionId: string): Promise<string> => {
  const canonical = await canonicalizeDeviceAnchor(anchor)
  return JSON.stringify([
    'thunderbolt-device-approval-sas-v1',
    'approve-account-key',
    'p256+mlkem768',
    `decimal-${approvalCodeLength}`,
    canonical.userId,
    canonical.deviceId,
    canonical.ecdhPublicKey,
    canonical.mlkemPublicKey,
    sessionId,
  ])
}

/** The new device's commitment to its reveal, sent before it sees any challenge. */
export const createApprovalCommitment = (context: string, reveal: string): Promise<string> =>
  sha256Hex(JSON.stringify(['commit', context, reveal]))

/** The code both screens show: the whole SHA-256 digest reduced mod 100, zero-padded to two digits. */
export const deriveApprovalCode = async (
  context: string,
  challengerDeviceId: string,
  challenge: string,
  reveal: string,
): Promise<string> => {
  const digest = await sha256Hex(JSON.stringify(['sas', context, challengerDeviceId, challenge, reveal]))
  return (BigInt(`0x${digest}`) % BigInt(codeModulus)).toString().padStart(approvalCodeLength, '0')
}

/** The trusted device's code for an attempt, or null when the reveal does not open the commitment. */
export const deriveVerifiedApprovalCode = async (
  anchor: DeviceAnchor,
  attempt: Omit<ApprovalCodeConfirmation, 'code'>,
  challengerDeviceId: string,
): Promise<string | null> => {
  const context = await createApprovalCodeContext(anchor, attempt.sessionId)
  if ((await createApprovalCommitment(context, attempt.reveal)) !== attempt.commitment) {
    return null
  }
  return deriveApprovalCode(context, challengerDeviceId, attempt.challenge, attempt.reveal)
}

/** Rebuild the attempt from the recipient tuple and check both the commitment and the chosen code. */
export const matchesApprovalCode = async (
  anchor: DeviceAnchor,
  confirmation: ApprovalCodeConfirmation,
  challengerDeviceId: string,
): Promise<boolean> =>
  (await deriveVerifiedApprovalCode(anchor, confirmation, challengerDeviceId)) === confirmation.code

/** The code plus five distinct random decoys, shuffled (Fisher–Yates). */
export const createApprovalCodeOptions = (code: string): string[] => {
  const options = new Set([code])
  while (options.size < approvalCodeOptionCount) {
    options.add(randomBelow(codeModulus).toString().padStart(approvalCodeLength, '0'))
  }
  const shuffled = [...options]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = randomBelow(index + 1)
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]]
  }
  return shuffled
}
