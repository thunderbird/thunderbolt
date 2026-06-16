/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DataTransformMiddleware, SyncDataBucket } from '../TransformableBucketStorage'
import { codec as defaultCodec, type EncryptionCodec } from '@/db/encryption/codec'

type SyncEntry = SyncDataBucket['data'][number]

const makeDecryptEntry = (codec: EncryptionCodec) => async (entry: SyncEntry) => {
  if (!entry.data) {
    return
  }

  try {
    const obj = JSON.parse(entry.data) as Record<string, unknown>
    let changed = false

    await Promise.all(
      Object.entries(obj).map(async ([key, val]) => {
        if (typeof val === 'string' && val.startsWith('__enc:')) {
          obj[key] = await codec.decode(val)
          changed = true
        }
      }),
    )

    if (changed) {
      entry.data = JSON.stringify(obj)
    }
  } catch (err) {
    console.warn('[EncryptionMiddleware] Failed to decrypt entry, leaving unchanged:', err)
  }
}

/**
 * Creates an encryption middleware using the given codec.
 * Production code uses the `encryptionMiddleware` singleton; tests pass a fake codec
 * directly instead of mocking the module.
 *
 * Decrypts encrypted columns in sync data before it reaches SQLite.
 * Data-driven: scans all string values for the __enc: prefix rather than consulting
 * encryptedColumnsMap, so stale desktop bundles handle newly-encrypted columns correctly.
 * codec.decode passes through plaintext and returns raw ciphertext when no CK is available.
 *
 * No isEncryptionEnabled() gate: this middleware runs in the SharedWorker where
 * localStorage is unavailable. The codec safely handles both encrypted and plaintext data.
 */
export const createEncryptionMiddleware = (codec: EncryptionCodec): DataTransformMiddleware => {
  const decryptEntry = makeDecryptEntry(codec)
  return {
    async transform(bucket) {
      await Promise.all(bucket.data.map(decryptEntry))
      return bucket
    },
  }
}

export const encryptionMiddleware = createEncryptionMiddleware(defaultCodec)
