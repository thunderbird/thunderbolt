/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'bun:test'
import { useConfigStore } from '@/api/config-store'
import { generateAK, mintDEK } from '@/crypto/primitives'
import { storeAK, storePrimaryKeyId, storeWrappedDEK } from '@/crypto/key-storage'
import { codec, resetCodecState } from '@/db/encryption/codec'
import { encodeForUpload } from '@/db/encryption/upload-encoder'
import type { SyncDataBucket } from '../TransformableBucketStorage'
import type { EncryptionCodec, EncryptionContext } from '@shared/e2ee-types'
import { createEncryptionMiddleware } from './EncryptionMiddleware'

type SyncEntry = SyncDataBucket['data'][number]

const makeEntry = (object_type: string, data: Record<string, unknown>, object_id = 'id-1'): SyncEntry =>
  ({ object_type, object_id, data: JSON.stringify(data), op: 'PUT' }) as SyncEntry

const makeBucket = (...entries: SyncEntry[]): SyncDataBucket => ({ data: entries }) as SyncDataBucket

const deleteKeyDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

// Controllable passthrough flag so individual tests can simulate a missing key.
// The fake codec is injected via createEncryptionMiddleware — no mock.module, so nothing
// leaks into the real codec's own suite (which a non-isolated runner would otherwise corrupt).
let keyAvailable = true

// Records every (value, ctx) pair decode was called with, so tests can prove the
// AAD tuple (table ‖ column ‖ rowId) the middleware rebuilds from the OplogEntry.
let decodeCalls: Array<{ value: string; ctx: EncryptionContext | undefined }> = []

const fakeCodec: EncryptionCodec = {
  encode: async (val) => `__enc:${val}`,
  decode: async (val, ctx) => {
    decodeCalls.push({ value: val, ctx })
    return !keyAvailable || !val.startsWith('__enc:') ? val : `decrypted(${val})`
  },
}

const encryptionMiddleware = createEncryptionMiddleware(fakeCodec)

afterEach(() => {
  keyAvailable = true
  decodeCalls = []
  useConfigStore.setState({ config: {} })
})

describe('encryptionMiddleware', () => {
  it('decrypts a real upload-encoded value with the reconstructed AAD tuple', async () => {
    await deleteKeyDatabase()
    resetCodecState()
    useConfigStore.setState({ config: { e2eeEnabled: true } })
    const ak = await generateAK()
    const { wrappedKey } = await mintDEK(ak)
    await storeAK(ak)
    await storeWrappedDEK('0', wrappedKey)
    await storePrimaryKeyId('0')

    const operation = await encodeForUpload({
      op: 'PUT',
      type: 'tasks',
      id: 'task-pipeline-1',
      data: { item: 'full pipeline plaintext', order: 1 },
    })
    expect(operation.data?.item).toMatch(/^__enc:v2:0:/)

    const result = await createEncryptionMiddleware(codec).transform(
      makeBucket(makeEntry(operation.type, operation.data!, operation.id)),
    )

    expect(JSON.parse(result.data[0].data!)).toEqual({
      item: 'full pipeline plaintext',
      order: 1,
    })
  })

  describe('AAD context threading (v2)', () => {
    it('passes {table: object_type, column: snake_case JSON key, rowId: object_id} to codec.decode', async () => {
      const entry = makeEntry('model_profiles', { api_key: '__enc:v2:0:iv1:ct1', display_name: 'plain' }, 'row-uuid-42')

      await encryptionMiddleware.transform(makeBucket(entry))

      expect(decodeCalls).toHaveLength(1)
      const { ctx } = decodeCalls[0]
      expect(ctx).toEqual({ table: 'model_profiles', column: 'api_key', rowId: 'row-uuid-42' })
    })

    it('rebuilds a distinct ctx per encrypted column of the same row', async () => {
      const entry = makeEntry('skills', { name: '__enc:v2:0:iv1:ct1', instruction: '__enc:v2:0:iv2:ct2' }, 'sk-9')

      await encryptionMiddleware.transform(makeBucket(entry))

      const byColumn = new Map(decodeCalls.map((c) => [c.ctx?.column, c.ctx]))
      expect(byColumn.get('name')).toEqual({ table: 'skills', column: 'name', rowId: 'sk-9' })
      expect(byColumn.get('instruction')).toEqual({ table: 'skills', column: 'instruction', rowId: 'sk-9' })
    })

    it('still passes v1-style two-segment __enc:<iv>:<ct> values to codec.decode with ctx', async () => {
      const entry = makeEntry('tasks', { item: '__enc:iv:ct' }, 'task-1')

      const result = await encryptionMiddleware.transform(makeBucket(entry))

      expect(decodeCalls).toHaveLength(1)
      expect(decodeCalls[0].value).toBe('__enc:iv:ct')
      expect(decodeCalls[0].ctx).toEqual({ table: 'tasks', column: 'item', rowId: 'task-1' })
      expect(JSON.parse(result.data[0].data!).item).toBe('decrypted(__enc:iv:ct)')
    })

    it('leaves encrypted values unchanged and never calls decode when object_type is missing', async () => {
      const entry = {
        object_id: 'id-1',
        data: JSON.stringify({ name: '__enc:v2:0:iv:ct' }),
        op: 'PUT',
      } as unknown as SyncEntry

      const result = await encryptionMiddleware.transform(makeBucket(entry))

      expect(decodeCalls).toHaveLength(0)
      expect(JSON.parse(result.data[0].data!).name).toBe('__enc:v2:0:iv:ct')
    })

    it('leaves encrypted values unchanged and never calls decode when object_id is missing', async () => {
      const entry = {
        object_type: 'skills',
        data: JSON.stringify({ name: '__enc:v2:0:iv:ct', label: 'plain' }),
        op: 'PUT',
      } as unknown as SyncEntry

      const result = await encryptionMiddleware.transform(makeBucket(entry))

      expect(decodeCalls).toHaveLength(0)
      const row = JSON.parse(result.data[0].data!)
      expect(row.name).toBe('__enc:v2:0:iv:ct')
      expect(row.label).toBe('plain')
    })
  })

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

    it('leaves plaintext values unchanged and never calls decode on them', async () => {
      const entry = makeEntry('tasks', { item: 'plain text', order: 2 })

      const result = await encryptionMiddleware.transform(makeBucket(entry))
      const row = JSON.parse(result.data[0].data!)

      expect(decodeCalls).toHaveLength(0)
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

    it('passes through __enc: values when codec returns them as-is (no key)', async () => {
      // When the key is unavailable, codec.decode returns the raw __enc: value.
      // The middleware writes it to SQLite; the client will retry on the next sync cycle.
      keyAvailable = false

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
