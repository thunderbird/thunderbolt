/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { SyncDataBucket } from '../TransformableBucketStorage'

type SyncEntry = SyncDataBucket['data'][number]

const makeEntry = (object_type: string, data: Record<string, unknown>): SyncEntry =>
  ({ object_type, object_id: 'id-1', data: JSON.stringify(data), op: 'PUT' }) as SyncEntry

const makeBucket = (...entries: SyncEntry[]): SyncDataBucket => ({ data: entries }) as SyncDataBucket

// Controllable passthrough flag so individual tests can simulate a missing CK
// without re-calling mock.module (which would bleed into subsequent tests).
let ckAvailable = true

mock.module('@/db/encryption/codec', () => ({
  codec: {
    decode: async (val: string) => {
      if (!ckAvailable || !val.startsWith('__enc:')) {
        return val
      }
      return `decrypted(${val})`
    },
    encode: async (val: string) => `__enc:${val}`,
  },
}))

const { encryptionMiddleware } = await import('./EncryptionMiddleware')

afterEach(() => {
  ckAvailable = true
})

describe('encryptionMiddleware', () => {
  describe('data-driven decryption (no encryptedColumnsMap dependency)', () => {
    it('decrypts __enc: values on a table not in encryptedColumnsMap', async () => {
      // Simulates a stale desktop client that predates `skills` being added to the map.
      // The middleware must still decrypt the values because __enc: is the authoritative signal.
      const entry = makeEntry('skills', {
        name: '__enc:iv1:ct1',
        description: '__enc:iv2:ct2',
        instruction: '__enc:iv3:ct3',
        workspace_id: 'ws-1',
      })

      const result = await encryptionMiddleware.transform(makeBucket(entry))
      const row = JSON.parse(result.data[0].data!)

      expect(row.name).toBe('decrypted(__enc:iv1:ct1)')
      expect(row.description).toBe('decrypted(__enc:iv2:ct2)')
      expect(row.instruction).toBe('decrypted(__enc:iv3:ct3)')
      expect(row.workspace_id).toBe('ws-1')
    })

    it('decrypts __enc: values on a known table', async () => {
      const entry = makeEntry('tasks', { item: '__enc:iv:ct', order: 1 })

      const result = await encryptionMiddleware.transform(makeBucket(entry))
      const row = JSON.parse(result.data[0].data!)

      expect(row.item).toBe('decrypted(__enc:iv:ct)')
      expect(row.order).toBe(1)
    })

    it('leaves plaintext values unchanged', async () => {
      const entry = makeEntry('tasks', { item: 'plain text', order: 2 })

      const result = await encryptionMiddleware.transform(makeBucket(entry))
      const row = JSON.parse(result.data[0].data!)

      expect(row.item).toBe('plain text')
      expect(row.order).toBe(2)
    })

    it('does not touch non-string values', async () => {
      const entry = makeEntry('skills', {
        name: '__enc:iv:ct',
        count: 42,
        active: true,
        meta: null,
      })

      const result = await encryptionMiddleware.transform(makeBucket(entry))
      const row = JSON.parse(result.data[0].data!)

      expect(row.count).toBe(42)
      expect(row.active).toBe(true)
      expect(row.meta).toBeNull()
    })

    it('passes through __enc: values when codec returns them as-is (no CK)', async () => {
      // When the CK is unavailable, codec.decode returns the raw __enc: value.
      // The middleware writes it to SQLite; the client will retry on the next sync cycle.
      ckAvailable = false

      const entry = makeEntry('skills', { name: '__enc:iv:ct' })
      const result = await encryptionMiddleware.transform(makeBucket(entry))
      const row = JSON.parse(result.data[0].data!)

      expect(row.name).toBe('__enc:iv:ct')
    })

    it('decrypts multiple entries in a bucket', async () => {
      const bucket = makeBucket(
        makeEntry('tasks', { item: '__enc:a:b' }),
        makeEntry('skills', { name: '__enc:c:d' }),
        makeEntry('other_table', { label: '__enc:e:f', extra: 'plain' }),
      )

      const result = await encryptionMiddleware.transform(bucket)

      expect(JSON.parse(result.data[0].data!).item).toBe('decrypted(__enc:a:b)')
      expect(JSON.parse(result.data[1].data!).name).toBe('decrypted(__enc:c:d)')
      expect(JSON.parse(result.data[2].data!).label).toBe('decrypted(__enc:e:f)')
      expect(JSON.parse(result.data[2].data!).extra).toBe('plain')
    })

    it('skips entries with no data', async () => {
      const entry = { object_type: 'tasks', object_id: 'id-1', data: null, op: 'DELETE' } as unknown as SyncEntry
      const result = await encryptionMiddleware.transform(makeBucket(entry))
      expect(result.data[0].data).toBeNull()
    })
  })
})
