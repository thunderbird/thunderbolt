/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import type { Settings } from '@/config/settings'

/** The org's escrow key as clients and the DB see it. */
export type OrgEscrowKey = {
  /** Base64 raw uncompressed P-256 point (65 bytes) — exactly what the operator configured. */
  publicKey: string
  fingerprint: string
}

/**
 * Frozen fingerprint format: base64(SHA-256(raw public key bytes)).
 * Display/audit only — not a security boundary in this POC.
 */
export const fingerprintPublicKey = (publicKeyRaw: Uint8Array): string =>
  createHash('sha256').update(publicKeyRaw).digest('base64')

/**
 * The org's escrow key, or `null` when `ORG_KMS_ESCROW_ENABLED` is false — the
 * one helper every route calls before touching org envelopes.
 *
 * This is the ENCRYPTION half of escrow and the only half the app has: the
 * operator hands the server a public key, the client wraps the AK against it,
 * and nothing here can unwrap the result. Recovery is a separate, out-of-band
 * operator tool (`scripts/kms-escrow-decrypt.ts`) holding the private key that
 * this server is deliberately never given. Settings are validated at boot, so
 * an enabled escrow always has a well-formed on-curve key by the time this runs.
 */
export const getOrgEscrowKey = (settings: Settings): OrgEscrowKey | null => {
  if (!settings.orgKmsEscrowEnabled) {
    return null
  }
  const publicKey = settings.orgKmsEscrowStaticPublicKey
  return { publicKey, fingerprint: fingerprintPublicKey(Buffer.from(publicKey, 'base64')) }
}
