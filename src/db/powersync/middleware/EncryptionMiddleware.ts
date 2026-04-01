import type { SyncDataBatch } from '@powersync/common'
import type { DataTransformMiddleware } from '../TransformableBucketStorage'
import { encryptedColumnsMap, isEncryptionEnabled } from '@/db/encryption/config'
import { codec } from '@/db/encryption/codec'

type SyncEntry = SyncDataBatch['buckets'][number]['data'][number]

/** Decrypt encrypted columns in a single sync entry. Mutates entry.data in place. */
const decryptEntry = async (entry: SyncEntry) => {
  if (!entry.object_type || !entry.data) {
    return
  }
  const columns = encryptedColumnsMap[entry.object_type]
  if (!columns) {
    return
  }

  try {
    const obj = JSON.parse(entry.data) as Record<string, unknown>
    let changed = false

    await Promise.all(
      columns.map(async (col) => {
        const val = obj[col]
        if (typeof val === 'string') {
          obj[col] = await codec.decode(val)
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
 * Config-driven: uses encryptedColumnsMap to determine which columns to decrypt.
 * Handles __enc: (AES-GCM) format.
 * Passes through when no CK is available (pre-setup or CK cleared).
 */
export const encryptionMiddleware: DataTransformMiddleware = {
  async transform(batch) {
    if (!isEncryptionEnabled()) {
      return batch
    }
    for (const bucket of batch.buckets) {
      for (const entry of bucket.data) {
        await decryptEntry(entry)
      }
    }
    return batch
  },
}
