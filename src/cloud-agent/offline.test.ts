/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from '@/db/database'
import { applySchema } from '@/db/apply-schema'
import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import { cloudAgentCacheTable, cloudAgentOutboxTable, cloudAgentProjectionsTable } from '@/db/tables'
import { createCloudOfflineStore } from './offline'
import { mergeCloudRecords, reconstructCloudRead } from './projections'

const command = {
  id: 'command-1',
  kind: 'message' as const,
  resourceId: 'chat',
  endpoint: 'conversations/chat/messages',
  payload: JSON.stringify({ commandId: 'command-1', content: { ciphertext: 'opaque' } }),
}

describe('cloud offline persistence', () => {
  const database = new Database()
  beforeEach(async () => {
    await database.initialize({ type: 'bun-sqlite', path: ':memory:' })
    await applySchema(database.db)
  })
  afterEach(async () => {
    await database.close()
  })

  it('caches and queues against SQLite views with PowerSync-style write triggers', async () => {
    for (const table of [cloudAgentCacheTable, cloudAgentOutboxTable]) {
      const name = getTableName(table)
      const backing = `${name}_storage`
      const columns = Object.values(getTableColumns(table)).map((column) => column.name)
      await database.db.run(sql.raw(`ALTER TABLE ${name} RENAME TO ${backing}`))
      await database.db.run(sql.raw(`CREATE VIEW ${name} AS SELECT * FROM ${backing}`))
      await database.db.run(
        sql.raw(`CREATE TRIGGER ${name}_insert INSTEAD OF INSERT ON ${name} BEGIN
        INSERT INTO ${backing} (${columns.join(',')}) VALUES (${columns.map((column) => `NEW.${column}`).join(',')}); END`),
      )
      await database.db.run(
        sql.raw(`CREATE TRIGGER ${name}_update INSTEAD OF UPDATE ON ${name} BEGIN
        UPDATE ${backing} SET ${columns.map((column) => `${column}=NEW.${column}`).join(',')} WHERE id=OLD.id; END`),
      )
    }
    const store = createCloudOfflineStore(database.db, 'owner')
    await store.cache('capabilities', { enabled: false })
    await store.cache('capabilities', { enabled: true })
    expect(await store.read<{ enabled: boolean }>('capabilities')).toEqual({ enabled: true })
    await store.enqueue(command)
    await store.enqueue(command)
    expect(await store.entries()).toHaveLength(1)
    await expect(store.enqueue({ ...command, payload: 'changed' })).rejects.toThrow('different content')
    await store.settle(command.id)
    expect(await store.entries()).toEqual([])
  })

  it('survives a new client/store with the exact original encrypted command', async () => {
    const first = createCloudOfflineStore(database.db, 'owner')
    await first.enqueue(command)
    const reopened = createCloudOfflineStore(database.db, 'owner')
    expect((await reopened.entries())[0].payload).toBe(command.payload)
    await reopened.enqueue(command)
    expect(await reopened.entries()).toHaveLength(1)
    await reopened.settle(command.id)
    expect(await first.entries()).toHaveLength(0)
  })

  it('rejects an attempt to reuse a command id with different content', async () => {
    const store = createCloudOfflineStore(database.db, 'owner')
    await store.enqueue(command)
    await expect(store.enqueue({ ...command, payload: 'different' })).rejects.toThrow('different content')
    expect((await store.entries())[0].payload).toBe(command.payload)
  })

  it('isolates cached records, downloaded artifacts, commands and acknowledgements by owner', async () => {
    const owner = createCloudOfflineStore(database.db, 'owner')
    const other = createCloudOfflineStore(database.db, 'other')
    await owner.cache('artifacts/a/revisions/r/content', { content: { ciphertext: 'private' } })
    await owner.enqueue(command)
    expect(await other.read('artifacts/a/revisions/r/content')).toBeUndefined()
    expect(await other.entries()).toEqual([])
    await other.settle(command.id)
    expect(await owner.entries()).toHaveLength(1)
  })

  it('keeps rejected saves reviewable until explicitly discarded', async () => {
    const store = createCloudOfflineStore(database.db, 'owner')
    await store.enqueue({ ...command, kind: 'agent-save' })
    await store.fail(command.id, '409')
    expect((await store.entries())[0]).toMatchObject({
      status: 'needs-review',
      errorCode: '409',
      payload: command.payload,
    })
    await store.discard(command.id)
    expect(await store.entries()).toEqual([])
  })

  it('reads server projections without writing them and combines them with a downloaded cache', async () => {
    const store = createCloudOfflineStore(database.db, 'owner')
    await store.cache('agents', { agents: [{ id: 'a', version: 1, config: { ciphertext: 'old' } }] })
    await database.db.insert(cloudAgentProjectionsTable).values({
      id: 'agent:a',
      userId: 'owner',
      kind: 'agent',
      payload: JSON.stringify({ id: 'a', version: 2, config: { ciphertext: 'new' } }),
      updatedAt: '2026-10-23T00:00:00Z',
    })
    await database.db.insert(cloudAgentProjectionsTable).values({
      id: 'agent:b',
      userId: 'other',
      kind: 'agent',
      payload: JSON.stringify({ id: 'b', version: 1 }),
      updatedAt: '2026-10-23T00:00:00Z',
    })
    expect(await store.read<unknown>('agents')).toEqual({
      agents: [{ id: 'a', version: 2, config: { ciphertext: 'new' } }],
    })
    expect(await database.db.select().from(cloudAgentProjectionsTable)).toHaveLength(2)
  })
})

describe('cloud record projection reconciliation', () => {
  it('does not replace a newer config with a delayed lower version', () => {
    expect(
      mergeCloudRecords(
        [{ id: 'a', version: 4 }],
        [
          {
            id: 'a',
            kind: 'agent',
            parentId: null,
            payload: JSON.stringify({ id: 'a', version: 3 }),
            updatedAt: '2099',
            deletedAt: null,
          },
        ],
      ),
    ).toEqual([{ id: 'a', version: 4 }])
  })
  it('removes a deleted record instead of resurrecting the API cache', () => {
    expect(
      mergeCloudRecords(
        [{ id: 'a', version: 2 }],
        [
          {
            id: 'a',
            kind: 'agent',
            parentId: null,
            payload: JSON.stringify({ id: 'a', version: 2 }),
            updatedAt: '2026',
            deletedAt: '2026',
          },
        ],
      ),
    ).toEqual([])
  })
  it('reconstructs a conversation from independently arriving rows', () => {
    const rows = [
      {
        id: 'conversation:c',
        kind: 'conversation',
        parentId: 'a',
        payload: JSON.stringify({ id: 'c' }),
        updatedAt: '2026',
        deletedAt: null,
      },
      {
        id: 'message:m',
        kind: 'message',
        parentId: 'c',
        payload: JSON.stringify({ id: 'm', sequence: 7, revision: 2 }),
        updatedAt: '2026',
        deletedAt: null,
      },
      {
        id: 'message:other',
        kind: 'message',
        parentId: 'other',
        payload: JSON.stringify({ id: 'other', sequence: 8 }),
        updatedAt: '2026',
        deletedAt: null,
      },
    ]
    expect(reconstructCloudRead('conversations/c', rows, undefined)).toEqual({
      conversation: { id: 'c' },
      runs: [],
      approvals: [],
      messages: [{ id: 'm', sequence: 7, revision: 2 }],
      cursor: 7,
    })
  })
})
