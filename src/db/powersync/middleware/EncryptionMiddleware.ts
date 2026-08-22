/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DataTransformMiddleware, SyncDataBucket } from '../TransformableBucketStorage'
import { codec as defaultCodec } from '@/db/encryption/codec'
import { isEncryptedValue } from '@/db/encryption/wire-format'
import type { EncryptionCodec, EncryptionContext } from '@shared/e2ee-types'

type SyncEntry = SyncDataBucket['data'][number]

/**
 * Decrypt all __enc:-prefixed values in a single sync entry. Mutates entry.data in place.
 *
 * Intentionally data-driven rather than map-driven: any string value starting with __enc:
 * is a decode candidate regardless of whether its column appears in encryptedColumnsMap.
 * This means a stale desktop client (whose bundled map predates a new encrypted column)
 * still decrypts correctly — the __enc: prefix is the authoritative signal, not the config.
 *
 * v2 AAD threading (THU-426): each decode receives the {table, column, rowId} the upload
 * encoder bound into AAD — `object_type` is the snake_case table, the JSON key is the
 * snake_case column, `object_id` is the row id. The codec parses the wire key_id and
 * rebuilds the full `table ‖ column ‖ rowId ‖ keyId` tuple internally. Legacy v1 values
 * ignore this context (they carry no AAD), so it is passed whenever available but omitted
 * (undefined) when the entry lacks object_type/object_id — the codec then fails open on a
 * v2 value rather than decrypting under the wrong AAD, while v1 values still decode.
 */
const decryptEntry = async (entry: SyncEntry, codec: EncryptionCodec) => {
  if (!entry.data) {
    return
  }

  try {
    const obj = JSON.parse(entry.data) as Record<string, unknown>
    const { object_type: table, object_id: rowId } = entry
    let changed = false

    await Promise.all(
      Object.entries(obj).map(async ([key, val]) => {
        if (typeof val !== 'string' || !isEncryptedValue(val)) {
          return
        }
        const ctx: EncryptionContext | undefined = table && rowId ? { table, column: key, rowId } : undefined
        const decoded = await codec.decode(val, ctx)
        if (decoded !== val) {
          obj[key] = decoded
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
 * Decrypts encrypted columns in sync data before it reaches SQLite.
 * Data-driven: scans all string values for the __enc: prefix rather than consulting
 * encryptedColumnsMap, so stale desktop bundles handle newly-encrypted columns correctly.
 *
 * codec.decode passes plaintext through, and returns the raw ciphertext when a key
 * is unavailable — which this layer then PERSISTS as the value. That fallback is
 * only meant for a missing individual DEK (the codec self-heals over the
 * key-request channel); a device with no keyring at all must never reach here,
 * which `ThunderboltConnector.canDecryptAccountData` enforces by withholding sync
 * credentials until the keyring lands.
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
