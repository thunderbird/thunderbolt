/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DataTransformMiddleware, SyncDataBucket } from '../TransformableBucketStorage'
import { codec as defaultCodec, type EncryptionCodec } from '@/db/encryption/codec'

type SyncEntry = SyncDataBucket['data'][number]

/**
 * Decrypt all __enc:-prefixed values in a single sync entry. Mutates entry.data in place.
 *
 * Intentionally data-driven rather than map-driven: any string value starting with __enc:
 * is decrypted regardless of whether its column appears in encryptedColumnsMap. This means
 * a stale desktop client (whose bundled map predates a new encrypted column) still decrypts
 * correctly — the __enc: prefix is the authoritative signal, not the config.
 */
const decryptEntry = async (entry: SyncEntry, codec: EncryptionCodec) => {
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
 *
 * The codec is injected (defaulting to the shared AES-GCM codec) so tests can supply a
 * fake without `mock.module('@/db/encryption/codec')`, which leaks across test files in a
 * non-isolated runner and corrupts the real codec's own suite.
 */
export const createEncryptionMiddleware = (codec: EncryptionCodec = defaultCodec): DataTransformMiddleware => ({
  async transform(bucket) {
    await Promise.all(bucket.data.map((entry) => decryptEntry(entry, codec)))
    return bucket
  },
})

export const encryptionMiddleware = createEncryptionMiddleware()
