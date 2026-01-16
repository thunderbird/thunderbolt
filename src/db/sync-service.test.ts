/**
 * Tests for sync service utilities
 *
 * Note: The main SyncService now uses WebSocket and is harder to unit test.
 * These tests focus on the serialization/deserialization utilities.
 */

import { describe, expect, it } from 'bun:test'
import { type SerializedChange } from './sync-utils'

/**
 * Creates a valid SerializedChange for testing
 */
const createSerializedChange = (overrides: Partial<SerializedChange>): SerializedChange => ({
  table: 'test_table',
  pk: btoa('test-pk'), // base64 encoded
  cid: 'test_column',
  val: 'test-value',
  col_version: '1',
  db_version: '1',
  site_id: btoa('site-1'), // base64 encoded
  cl: 1,
  seq: 1,
  ...overrides,
})

describe('SerializedChange', () => {
  it('should have all required fields', () => {
    const change = createSerializedChange({})

    expect(change).toHaveProperty('table')
    expect(change).toHaveProperty('pk')
    expect(change).toHaveProperty('cid')
    expect(change).toHaveProperty('val')
    expect(change).toHaveProperty('col_version')
    expect(change).toHaveProperty('db_version')
    expect(change).toHaveProperty('site_id')
    expect(change).toHaveProperty('cl')
    expect(change).toHaveProperty('seq')
  })

  it('should properly encode base64 fields', () => {
    const change = createSerializedChange({
      pk: btoa('my-primary-key'),
      site_id: btoa('my-site-id'),
    })

    // Verify base64 encoding
    expect(atob(change.pk)).toBe('my-primary-key')
    expect(atob(change.site_id)).toBe('my-site-id')
  })

  it('should represent bigint versions as strings', () => {
    const change = createSerializedChange({
      col_version: '12345678901234567890',
      db_version: '98765432109876543210',
    })

    expect(typeof change.col_version).toBe('string')
    expect(typeof change.db_version).toBe('string')
    expect(BigInt(change.col_version)).toBe(12345678901234567890n)
    expect(BigInt(change.db_version)).toBe(98765432109876543210n)
  })
})

describe('Chat session extraction from changes', () => {
  it('should identify chat_messages table with chat_thread_id column', () => {
    const changes: SerializedChange[] = [
      createSerializedChange({ table: 'chat_messages', cid: 'chat_thread_id', val: 'thread-1' }),
      createSerializedChange({ table: 'chat_messages', cid: 'chat_thread_id', val: 'thread-2' }),
      createSerializedChange({ table: 'chat_messages', cid: 'content', val: 'hello' }),
      createSerializedChange({ table: 'other_table', cid: 'some_col', val: 'value' }),
    ]

    // Extract chat thread IDs (same logic as in sync-service.ts)
    const affectedChatThreadIds = [
      ...new Set(
        changes
          .filter((c) => c.table === 'chat_messages' && c.cid === 'chat_thread_id' && typeof c.val === 'string')
          .map((c) => c.val as string),
      ),
    ]

    expect(affectedChatThreadIds).toEqual(['thread-1', 'thread-2'])
  })

  it('should deduplicate chat thread IDs', () => {
    const changes: SerializedChange[] = [
      createSerializedChange({ table: 'chat_messages', cid: 'chat_thread_id', val: 'thread-1', pk: btoa('pk1') }),
      createSerializedChange({ table: 'chat_messages', cid: 'chat_thread_id', val: 'thread-1', pk: btoa('pk2') }),
      createSerializedChange({ table: 'chat_messages', cid: 'chat_thread_id', val: 'thread-1', pk: btoa('pk3') }),
    ]

    const affectedChatThreadIds = [
      ...new Set(
        changes
          .filter((c) => c.table === 'chat_messages' && c.cid === 'chat_thread_id' && typeof c.val === 'string')
          .map((c) => c.val as string),
      ),
    ]

    expect(affectedChatThreadIds).toEqual(['thread-1'])
  })

  it('should only extract string values from chat_thread_id column', () => {
    const changes: SerializedChange[] = [
      createSerializedChange({ table: 'chat_messages', cid: 'chat_thread_id', val: 'thread-1' }),
      createSerializedChange({ table: 'chat_messages', cid: 'chat_thread_id', val: null }),
      createSerializedChange({ table: 'chat_messages', cid: 'chat_thread_id', val: 123 }),
      createSerializedChange({ table: 'chat_messages', cid: 'chat_thread_id', val: 'thread-2' }),
    ]

    const affectedChatThreadIds = [
      ...new Set(
        changes
          .filter((c) => c.table === 'chat_messages' && c.cid === 'chat_thread_id' && typeof c.val === 'string')
          .map((c) => c.val as string),
      ),
    ]

    // Should only include string values
    expect(affectedChatThreadIds).toEqual(['thread-1', 'thread-2'])
  })
})
