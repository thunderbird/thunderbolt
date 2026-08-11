/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useConfigStore } from '@/api/config-store'
import { generateAK, mintDEK } from '@/crypto/primitives'
import { storeAK, storePrimaryKeyId, storeWrappedDEK } from '@/crypto/key-storage'

// Re-provide the real config module to override leaked mocks from other test
// files (bun's mock.module leaks across files and can replace encryptedColumnsMap).
const realConfig = await import('./config')
mock.module('@/db/encryption/config', () => ({ ...realConfig }))

const { codec, resetCodecState } = await import('./codec')
const { encodeForUpload } = await import('./upload-encoder')
const { isV2EncryptedValue } = await import('./wire-format')

const deleteDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('thunderbolt-keys')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })

const setupKeyring = async () => {
  const ak = await generateAK()
  await storeAK(ak)
  const { wrappedKey } = await mintDEK(ak)
  await storeWrappedDEK('0', wrappedKey)
  await storePrimaryKeyId('0')
}

describe('encodeForUpload', () => {
  beforeEach(async () => {
    await deleteDatabase()
    resetCodecState()
    await setupKeyring()
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })
  })

  afterEach(() => {
    useConfigStore.setState({ config: {} })
  })

  it('encrypts configured columns, binding op.id as the AAD rowId (round-trip)', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'tasks',
      id: 'row-1',
      data: { item: 'Buy groceries', order: 1, is_complete: 0 },
    }

    const result = await encodeForUpload(op)
    const encoded = result.data?.item as string
    expect(isV2EncryptedValue(encoded)).toBe(true)
    expect(result.data?.order).toBe(1)
    expect(result.data?.is_complete).toBe(0)

    // The middleware rebuilds ctx as {table: object_type, column, rowId: object_id}
    // — decoding with op.id as rowId proves encode bound the same tuple.
    expect(await codec.decode(encoded, { table: 'tasks', column: 'item', rowId: 'row-1' })).toBe('Buy groceries')
    // A different rowId fails AES-GCM auth → raw value returned.
    expect(await codec.decode(encoded, { table: 'tasks', column: 'item', rowId: 'row-2' })).toBe(encoded)
  })

  it('encodes exactly once per op — one decode returns the original plaintext', async () => {
    const op = { op: 'PUT' as const, type: 'tasks', id: 'row-1', data: { item: 'plain' } }
    const result = await encodeForUpload(op)
    const decodedOnce = await codec.decode(result.data?.item as string, {
      table: 'tasks',
      column: 'item',
      rowId: 'row-1',
    })
    expect(decodedOnce).toBe('plain')
  })

  it('encrypts encrypted columns for PATCH operations', async () => {
    const op = { op: 'PATCH' as const, type: 'tasks', id: 'row-1', data: { item: 'Updated task' } }
    const result = await encodeForUpload(op)
    expect(isV2EncryptedValue(result.data?.item as string)).toBe(true)
  })

  it('encrypts multiple configured columns and leaves others untouched', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'chat_messages',
      id: 'msg-1',
      data: { content: 'Hello', parts: '[{"type":"text"}]', chat_thread_id: 'thread-1' },
    }

    const result = await encodeForUpload(op)
    expect(isV2EncryptedValue(result.data?.content as string)).toBe(true)
    expect(isV2EncryptedValue(result.data?.parts as string)).toBe(true)
    expect(result.data?.chat_thread_id).toBe('thread-1')
  })

  it('skips configured columns holding non-string values explicitly', async () => {
    const op = {
      op: 'PUT' as const,
      type: 'tasks',
      id: 'row-1',
      data: { item: null, order: 5 },
    }

    const result = await encodeForUpload(op)
    expect(result.data?.item).toBeNull()
    expect(result.data?.order).toBe(5)
  })

  it('skips configured columns absent from the payload', async () => {
    const op = { op: 'PATCH' as const, type: 'tasks', id: 'row-1', data: { order: 2 } }
    const result = await encodeForUpload(op)
    expect(result.data).toEqual({ order: 2 })
  })

  it('passes through DELETE operations', async () => {
    const op = { op: 'DELETE' as const, type: 'tasks', id: 'row-1' }
    expect(await encodeForUpload(op)).toEqual(op)
  })

  it('passes through unconfigured tables', async () => {
    const op = { op: 'PUT' as const, type: 'unknown_table', id: 'row-1', data: { foo: 'bar' } }
    const result = await encodeForUpload(op)
    expect(result.data?.foo).toBe('bar')
  })

  it('passes through when encryption is disabled', async () => {
    useConfigStore.setState({ config: {} })
    const op = { op: 'PUT' as const, type: 'tasks', id: 'row-1', data: { item: 'plain' } }
    const result = await encodeForUpload(op)
    expect(result.data?.item).toBe('plain')
  })
})
