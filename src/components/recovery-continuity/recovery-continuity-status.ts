/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { EncryptionMetadataResponse } from '@shared/e2ee-types'

/**
 * What the UI shows about the recovery phrase's continuity seal:
 * - `hidden`: nothing to do, or nothing known;
 * - `warning` / `offline`: a trusted device can update it now / once online;
 * - `untrusted`: the phrase needs an update but this device is not approved;
 * - `unverified`: this device's own account key was adopted without a seal
 *   check, whatever the account's seal state.
 */
export type RecoveryContinuityStatus = 'hidden' | 'warning' | 'offline' | 'untrusted' | 'unverified'

/** What the UI shows about the passkey slot's seal. `blocked`: unsealed, and this device cannot update it now. */
export type PasskeyContinuityStatus = 'none' | 'protected' | 'needsUpdate' | 'blocked'

/** `ready`: the device holds usable sync keys. `unverified`: they were adopted without a continuity check. */
export type DeviceKeyTrust = { ready: boolean; unverified: boolean }

export type RecoveryContinuityInputs = {
  userId: string | null
  trust: DeviceKeyTrust
  isOnline: boolean
  /** The latest response this session; `undefined` before any, `null` for an account without encryption. */
  metadata: EncryptionMetadataResponse | null | undefined
  cachedUpdateRequiredFor: string | null
}

/**
 * Does the account's recovery phrase lack a seal? Strict on purpose: a backend
 * without the column omits `recovery_continuity`, and `undefined` must never
 * read as "needs an update", or the client would chase a seal nothing can store.
 */
export const accountNeedsContinuityUpdate = (metadata: EncryptionMetadataResponse | null): boolean =>
  metadata != null &&
  metadata.kdf_salt != null &&
  metadata.recovery_wrapped_ak != null &&
  metadata.recovery_continuity === null

/** Does the account's passkey slot lack a seal? As strict as the phrase check. */
export const passkeyNeedsContinuityUpdate = (metadata: EncryptionMetadataResponse | null): boolean =>
  metadata != null &&
  metadata.passkey_credential_id != null &&
  'passkey_continuity' in metadata &&
  metadata.passkey_continuity === null

/**
 * The offline cache's next value after an online answer. Only a v2 response
 * changes it: an unsealed account records its user, and a sealed one clears the
 * cache only when the cache belongs to that user.
 */
export const nextUpdateRequiredCache = (
  cachedFor: string | null,
  userId: string,
  metadata: EncryptionMetadataResponse | null,
): string | null => {
  if (!metadata || metadata.kdf_salt == null || !('recovery_continuity' in metadata)) {
    return cachedFor
  }
  if (accountNeedsContinuityUpdate(metadata)) {
    return userId
  }
  return metadata.recovery_continuity != null && cachedFor === userId ? null : cachedFor
}

/**
 * Does this user's phrase still need an update? This session's metadata answers
 * when it has loaded; until then the offline cache does, but only for the user
 * it was written for.
 */
export const phraseUpdateRequired = (
  metadata: EncryptionMetadataResponse | null | undefined,
  cachedUpdateRequiredFor: string | null,
  userId: string | null,
): boolean =>
  userId !== null &&
  (metadata === undefined ? cachedUpdateRequiredFor === userId : accountNeedsContinuityUpdate(metadata))

/** The phrase status, from this session's response or, without one, the cache for this user. */
export const deriveRecoveryContinuityStatus = ({
  userId,
  trust,
  isOnline,
  metadata,
  cachedUpdateRequiredFor,
}: RecoveryContinuityInputs): RecoveryContinuityStatus => {
  if (!userId) {
    return 'hidden'
  }
  if (trust.unverified) {
    return 'unverified'
  }
  if (!phraseUpdateRequired(metadata, cachedUpdateRequiredFor, userId)) {
    return 'hidden'
  }
  if (!trust.ready) {
    return 'untrusted'
  }
  return isOnline ? 'warning' : 'offline'
}

/** The passkey status. No offline cache: its ceremony needs the network anyway. */
export const derivePasskeyContinuityStatus = ({
  trust,
  isOnline,
  metadata,
}: RecoveryContinuityInputs): PasskeyContinuityStatus => {
  if (!metadata || metadata.passkey_credential_id == null || !('passkey_continuity' in metadata)) {
    return 'none'
  }
  if (metadata.passkey_continuity != null) {
    return 'protected'
  }
  return trust.ready && !trust.unverified && isOnline ? 'needsUpdate' : 'blocked'
}
