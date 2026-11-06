/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DeviceAnchor } from './canary'
import { ValidationError } from './errors'
import {
  exportMlKemPublicKey,
  exportPublicKey,
  importMlKemPublicKey,
  importPublicKey,
  isUsableMlKemPublicKey,
} from './primitives'

/** Compute the displayed fingerprint for a canonical account, device and public-key tuple. */
export const createDeviceApprovalFingerprint = async (anchor: DeviceAnchor): Promise<string> => {
  const ecdhPublicKey = await exportPublicKey(await importPublicKey(anchor.ecdhPublicKey.replace(/[\t\n\f\r ]/g, '')))
  const mlkemPublicKey = importMlKemPublicKey(anchor.mlkemPublicKey.replace(/[\t\n\f\r ]/g, ''))
  if (!isUsableMlKemPublicKey(mlkemPublicKey)) {
    throw new ValidationError('Device has an invalid ML-KEM public key')
  }
  const payload = JSON.stringify([
    'thunderbolt-device-approval-v1',
    anchor.userId,
    anchor.deviceId,
    ecdhPublicKey,
    exportMlKemPublicKey(mlkemPublicKey),
  ])
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .match(/.{4}/g)!
    .join('-')
}

/** Accept only ASCII spaces, presentation hyphens and hex case as formatting. */
export const normalizeDeviceApprovalFingerprint = (value: string): string => {
  if (!/^[a-fA-F0-9 -]+$/.test(value)) {
    return ''
  }
  const normalized = value.replace(/[ -]/g, '').toUpperCase()
  return normalized.length === 64 ? normalized : ''
}

/** Compare all 256 fingerprint bits without an early exit on a differing digit. */
export const matchesDeviceApprovalFingerprint = async (anchor: DeviceAnchor, value: string): Promise<boolean> => {
  const supplied = normalizeDeviceApprovalFingerprint(value)
  if (!supplied) {
    return false
  }
  const expected = normalizeDeviceApprovalFingerprint(await createDeviceApprovalFingerprint(anchor))
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index)
  }
  return difference === 0
}
