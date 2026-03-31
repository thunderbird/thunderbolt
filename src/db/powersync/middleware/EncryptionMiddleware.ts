import type { SyncDataBatch } from '@powersync/common'
import type { DataTransformMiddleware } from '../TransformableBucketStorage'
import { encryptedColumnsMap } from '@/db/encryption/config'
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

    for (const col of columns) {
      const val = obj[col]
      if (typeof val === 'string') {
        obj[col] = await codec.decode(val)
        changed = true
      }
    }

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
 * Handles __enc: (AES-GCM), b64: (legacy base64), and unprefixed base64 formats.
 * Passes through when no CK is available (pre-setup or CK cleared).
 */
export const encryptionMiddleware: DataTransformMiddleware = {
  async transform(batch) {
    for (const bucket of batch.buckets) {
      for (const entry of bucket.data) {
        await decryptEntry(entry)
      }
    }
    return batch
  },
}
