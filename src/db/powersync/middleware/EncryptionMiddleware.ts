/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DataTransformMiddleware, SyncDataBucket } from '../TransformableBucketStorage'
import { codec as defaultCodec } from '@/db/encryption/codec'
import { isEncryptedValue } from '@/db/encryption/wire-format'
import type { EncryptionCodec } from '@shared/e2ee-types'

type SyncEntry = SyncDataBucket['data'][number]

/**
 * Decrypt all __enc:-prefixed values in a single sync entry. Mutates entry.data in place.
 *
 * Intentionally data-driven rather than map-driven: any string value starting with __enc:
 * is a decode candidate regardless of whether its column appears in encryptedColumnsMap.
 * This means a stale desktop client (whose bundled map predates a new encrypted column)
 * still decrypts correctly — the __enc: prefix is the authoritative signal, not the config.
 *
 * v2 AAD threading (THU-426): every decode receives {table, column, rowId} rebuilt from
 * the OplogEntry — `object_type` is the snake_case table name, the JSON key is the
 * snake_case column name, `object_id` is the row id. These are the exact values the
 * upload encoder bound into AAD at encode time; the codec parses the wire key_id and
 * reconstructs the full `table ‖ column ‖ rowId ‖ keyId` tuple internally. If the entry
 * lacks `object_type`/`object_id`, AAD cannot be rebuilt, so the value is left as-is
 * (fail-open, matching pre-existing no-key behavior) rather than decrypted under a
 * wrong AAD.
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
        if (typeof val !== 'string' || !isEncryptedValue(val)) {
          return
        }
        const { object_type: table, object_id: rowId } = entry
        if (!table || !rowId) {
          console.warn(
            '[EncryptionMiddleware] Encrypted value on an entry without object_type/object_id — cannot rebuild AAD, leaving value unchanged',
            { object_type: table, object_id: rowId, column: key },
          )
          return
        }
        obj[key] = await codec.decode(val, { table, column: key, rowId })
        changed = true
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
 * Decrypts encrypted columns in sync data before it reaches SQLite.
 * Data-driven: scans all string values for the __enc: prefix rather than consulting
 * encryptedColumnsMap, so stale desktop bundles handle newly-encrypted columns correctly.
 * codec.decode passes through plaintext and returns raw ciphertext when no key is available.
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
