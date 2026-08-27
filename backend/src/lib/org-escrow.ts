/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { p256RawPublicKeyLength } from '@shared/e2ee-types'
import { createHash, createPublicKey } from 'node:crypto'

/**
 * Resolved org-escrow key configuration (THU-804). When enabled, `publicKey`
 * is the operator's base64 raw uncompressed P-256 point and `fingerprint` is
 * base64(SHA-256(raw public key bytes)) — display/audit only.
 */
export type OrgKeyInfo = { enabled: false } | { enabled: true; publicKey: string; fingerprint: string }

/** Fingerprints are content-addressed by the public-key string, so a module-level cache never staled. */
const fingerprintCache = new Map<string, string>()

/** Reject a point that decodes to the right shape but does not lie on P-256. */
const isOnCurve = (raw: Buffer): boolean => {
  const toBase64Url = (bytes: Buffer): string => bytes.toString('base64url')
  try {
    createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: toBase64Url(raw.subarray(1, 33)), y: toBase64Url(raw.subarray(33, 65)) },
      format: 'jwk',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Validate an org-escrow public key, returning a descriptive message or `null`
 * when it is a well-formed base64 raw uncompressed P-256 point ON the curve.
 *
 * Shared by startup settings validation and `getOrgKeyInfo` so a typo'd
 * ORG_ESCROW_PUBLIC_KEY aborts the boot instead of 500ing every encryption
 * write. The on-curve check makes this equivalent to what the client's
 * `crypto.subtle.importKey` will accept: if the server starts, clients can wrap.
 */
export const validateOrgEscrowPublicKey = (publicKey: string): string | null => {
  if (!publicKey) {
    return 'ORG_ESCROW_ENABLED is true but ORG_ESCROW_PUBLIC_KEY is not set'
  }
  const raw = Buffer.from(publicKey, 'base64')
  if (raw.length !== p256RawPublicKeyLength) {
    return `ORG_ESCROW_PUBLIC_KEY must decode to a ${p256RawPublicKeyLength}-byte raw uncompressed P-256 point — got ${raw.length} bytes`
  }
  if (raw[0] !== 0x04) {
    return 'ORG_ESCROW_PUBLIC_KEY must be an UNCOMPRESSED P-256 point (leading byte 0x04)'
  }
  if (!isOnCurve(raw)) {
    return 'ORG_ESCROW_PUBLIC_KEY is not a valid P-256 point (not on the curve)'
  }
  return null
}

/**
 * Resolve the configured org-escrow key and its fingerprint.
 *
 * Throws when escrow is enabled but the key is unusable. In a correctly booted
 * process this is unreachable — settings validation rejects a bad key at
 * startup — so it stands as a guard for directly-constructed Settings (tests).
 */
export const getOrgKeyInfo = (settings: Pick<Settings, 'orgEscrowEnabled' | 'orgEscrowPublicKey'>): OrgKeyInfo => {
  if (!settings.orgEscrowEnabled) {
    return { enabled: false }
  }

  const publicKey = settings.orgEscrowPublicKey
  const cached = fingerprintCache.get(publicKey)
  if (cached) {
    return { enabled: true, publicKey, fingerprint: cached }
  }

  const error = validateOrgEscrowPublicKey(publicKey)
  if (error) {
    throw new Error(error)
  }

  const fingerprint = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64')
  fingerprintCache.set(publicKey, fingerprint)
  return { enabled: true, publicKey, fingerprint }
}
