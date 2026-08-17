/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import type { SyncDataBucket } from '../TransformableBucketStorage'
import type { EncryptionCodec, EncryptionContext } from '@/db/encryption/codec'
import { createEncryptionMiddleware } from './EncryptionMiddleware'

type SyncEntry = SyncDataBucket['data'][number]

const makeEntry = (object_type: string, data: Record<string, unknown>): SyncEntry =>
  ({ object_type, object_id: 'id-1', data: JSON.stringify(data), op: 'PUT' }) as SyncEntry

const makeBucket = (...entries: SyncEntry[]): SyncDataBucket => ({ data: entries }) as SyncDataBucket

// Controllable passthrough flag so individual tests can simulate a missing CK.
// The fake codec is injected via createEncryptionMiddleware — no mock.module, so nothing
// leaks into the real codec's own suite (which a non-isolated runner would otherwise corrupt).
let ckAvailable = true

const fakeCodec: EncryptionCodec = {
  encode: async (val) => `__enc:${val}`,
  decode: async (val) => (!ckAvailable || !val.startsWith('__enc:') ? val : `decrypted(${val})`),
}

const encryptionMiddleware = createEncryptionMiddleware(fakeCodec)

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

  describe('v2 AAD threading (TD1)', () => {
    type DecodeCall = { value: string; ctx: EncryptionContext | undefined }

    /**
     * Spy codec that records the {table, column, rowId} context threaded per value
     * and simulates the codec's dual-read: v2 values decrypt (context-bound), legacy
     * v1 values decrypt with the context ignored, and a value under an unknown key_id
     * fails open (returned raw) exactly as the real codec does after a failed
     * lazy-fetch. When no context is supplied a v2 value also fails open.
     */
    const makeSpyCodec = (calls: DecodeCall[]): EncryptionCodec => ({
      encode: async (value) => value,
      decode: async (value, ctx) => {
        calls.push({ value, ctx })
        if (value.startsWith('__enc:v2:0:')) {
          return ctx ? `v2-decrypted(${value})` : value
        }
        if (value.startsWith('__enc:v2:')) {
          return value // unknown key_id — fail open
        }
        return `v1-decrypted(${value})` // legacy v1, no AAD
      },
    })

    const makeCustomEntry = (fields: Partial<SyncEntry>): SyncEntry =>
      ({ object_type: 'tasks', object_id: 'row-9', op: 'PUT', ...fields }) as SyncEntry

    it('threads {table, column, rowId} from the OplogEntry into codec.decode for a v2 value', async () => {
      const calls: DecodeCall[] = []
      const mw = createEncryptionMiddleware(makeSpyCodec(calls))
      const entry = makeCustomEntry({ data: JSON.stringify({ item: '__enc:v2:0:iv:ct' }) })

      const result = await mw.transform(makeBucket(entry))

      expect(calls).toEqual([{ value: '__enc:v2:0:iv:ct', ctx: { table: 'tasks', column: 'item', rowId: 'row-9' } }])
      expect(JSON.parse(result.data[0].data!).item).toBe('v2-decrypted(__enc:v2:0:iv:ct)')
    })

    it('passes context for a legacy v1 value (codec ignores it, decodes with no AAD)', async () => {
      const calls: DecodeCall[] = []
      const mw = createEncryptionMiddleware(makeSpyCodec(calls))
      const entry = makeCustomEntry({
        object_type: 'skills',
        object_id: 'sk-1',
        data: JSON.stringify({ name: '__enc:iv:ct' }),
      })

      const result = await mw.transform(makeBucket(entry))

      expect(calls).toEqual([{ value: '__enc:iv:ct', ctx: { table: 'skills', column: 'name', rowId: 'sk-1' } }])
      expect(JSON.parse(result.data[0].data!).name).toBe('v1-decrypted(__enc:iv:ct)')
    })

    it('leaves a value under an unknown key_id unchanged when the codec fails open', async () => {
      const calls: DecodeCall[] = []
      const mw = createEncryptionMiddleware(makeSpyCodec(calls))
      const entry = makeCustomEntry({ data: JSON.stringify({ item: '__enc:v2:99:iv:ct' }) })

      const result = await mw.transform(makeBucket(entry))

      expect(calls).toEqual([{ value: '__enc:v2:99:iv:ct', ctx: { table: 'tasks', column: 'item', rowId: 'row-9' } }])
      expect(JSON.parse(result.data[0].data!).item).toBe('__enc:v2:99:iv:ct')
    })

    it('omits context (undefined) when the entry lacks object_type/object_id', async () => {
      const calls: DecodeCall[] = []
      const mw = createEncryptionMiddleware(makeSpyCodec(calls))
      // A v2 value with no rebuildable AAD fails open; a v1 value on the same entry still decodes.
      const entry = {
        op: 'PUT',
        data: JSON.stringify({ item: '__enc:v2:0:iv:ct', name: '__enc:iv:ct' }),
      } as unknown as SyncEntry

      const result = await mw.transform(makeBucket(entry))

      expect(calls).toEqual(
        expect.arrayContaining([
          { value: '__enc:v2:0:iv:ct', ctx: undefined },
          { value: '__enc:iv:ct', ctx: undefined },
        ]),
      )
      const row = JSON.parse(result.data[0].data!)
      expect(row.item).toBe('__enc:v2:0:iv:ct')
      expect(row.name).toBe('v1-decrypted(__enc:iv:ct)')
    })
  })
})
