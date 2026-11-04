/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID, type EntryId, type Storage, type StorageWrite } from '@earendil-works/pi-durable'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api'
import postgres from 'postgres'
import * as runtimeSchema from '../../db/cloud-runtime-schema'
import { openPostgresRuntimeStore, type PostgresRuntimeStore, type StorageCodec } from './index'

const databaseUrl = process.env.CLOUD_AGENT_TEST_DATABASE_URL
const context = BACKGROUND_CONTEXT
const suite = databaseUrl ? describe : describe.skip

/** A real authenticated test codec exercises every storage round trip and binds ciphertext to its address. */
const testCodec = (): StorageCodec => {
  const key = randomBytes(32)
  return {
    encode: async (plaintext, address) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(Buffer.from(address))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
    },
    decode: async (ciphertext, address) => {
      const bytes = Buffer.from(ciphertext, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAAD(Buffer.from(address))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()
    },
    index: async (value) => createHmac('sha256', key).update(value).digest('hex'),
  }
}

suite('Postgres cloud runtime storage', () => {
  const sql = postgres(databaseUrl!, { max: 2, onnotice: () => {} })
  const namespaces = new Set<string>()
  let store: PostgresRuntimeStore
  const fatalEvents: Error[] = []

  beforeAll(async () => {
    const existing = await sql<
      { relation: string | null }[]
    >`SELECT to_regclass('cloud_runtime_namespaces')::text AS relation`
    if (!existing[0]?.relation) {
      const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(runtimeSchema))
      for (const statement of statements) {
        await sql.unsafe(statement)
      }
    }
    store = await openPostgresRuntimeStore({
      connectionString: databaseUrl!,
      onFatal: (error) => {
        fatalEvents.push(error)
      },
    })
  }, 30_000)

  afterAll(async () => {
    await store?.close()
    for (const namespace of namespaces) {
      await sql`DELETE FROM cloud_runtime_namespaces WHERE namespace = ${namespace}`
    }
    await sql.end()
  })

  const fixture = async (
    codec: StorageCodec = testCodec(),
  ): Promise<{ namespace: string; storage: Storage; codec: StorageCodec }> => {
    const namespace = `storage-test-${randomUUID()}`
    namespaces.add(namespace)
    return { namespace, storage: await store.openNamespace(namespace, codec), codec }
  }

  registerStorageConformance({ describe, expect, it }, 'upstream 1.3 conformance with AES-GCM', async (use) => {
    const { storage } = await fixture()
    try {
      await use(storage)
    } finally {
      await storage.close(context)
    }
  })

  it('persists uncommitted minted identities and committed records across namespace reopen', async () => {
    const { namespace, storage, codec } = await fixture()
    await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context)
    const minted = await storage.mintId()
    await storage.close(context)
    const reopened = await store.openNamespace(namespace, codec)
    expect(await reopened.mintId()).toBeGreaterThan(minted)
    expect(await reopened.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID })
    await reopened.close(context)
  })

  it('isolates identical IDs in separate namespaces and rejects foreign cursors', async () => {
    const first = await fixture()
    const second = await fixture()
    const writes: StorageWrite[] = [
      { type: 'conversation', value: { id: ROOT_CONVERSATION_ID } },
      {
        type: 'entry',
        value: {
          id: 2 as EntryId,
          conversationId: ROOT_CONVERSATION_ID,
          kind: 'message',
          data: { text: 'private first' },
        },
      },
      {
        type: 'entry',
        value: {
          id: 3 as EntryId,
          conversationId: ROOT_CONVERSATION_ID,
          kind: 'message',
          data: { text: 'private second' },
        },
      },
    ]
    await first.storage.commit(writes, context)
    await second.storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context)
    expect(await second.storage.entry(2 as EntryId, context)).toBeUndefined()
    const page = await first.storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1, undefined, context)
    await expect(
      second.storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1, page.next, context),
    ).rejects.toThrow('Foreign')
    await first.storage.close(context)
    await second.storage.close(context)
  })

  it('persists ciphertext only and authenticates namespace, identity and revision metadata', async () => {
    const { namespace, storage, codec } = await fixture()
    await storage.commit(
      [
        { type: 'conversation', value: { id: ROOT_CONVERSATION_ID } },
        {
          type: 'entry',
          value: {
            id: 2 as EntryId,
            conversationId: ROOT_CONVERSATION_ID,
            kind: 'message',
            data: { secret: 'never-visible-in-database' },
          },
        },
      ],
      context,
    )
    const rows = await sql<
      { payload: string }[]
    >`SELECT payload FROM cloud_runtime_records WHERE namespace = ${namespace}`
    expect(JSON.stringify(rows)).not.toContain('never-visible-in-database')
    const row = rows[0]!
    await expect(codec.decode(row.payload, 'different authenticated address')).rejects.toThrow()
    await storage.close(context)
  })

  it('rolls back earlier writes when encryption fails midway through a batch', async () => {
    const goodCodec = testCodec()
    const brokenCodec: StorageCodec = {
      ...goodCodec,
      encode: async (plaintext, address) => {
        if (plaintext.includes('fail-encryption')) {
          throw new Error('injected encryption failure')
        }
        return goodCodec.encode(plaintext, address)
      },
    }
    const { storage } = await fixture(brokenCodec)
    await expect(
      storage.commit(
        [
          { type: 'conversation', value: { id: ROOT_CONVERSATION_ID } },
          {
            type: 'entry',
            value: {
              id: 2 as EntryId,
              conversationId: ROOT_CONVERSATION_ID,
              kind: 'message',
              data: { text: 'fail-encryption' },
            },
          },
        ],
        context,
      ),
    ).rejects.toThrow('injected')
    expect(await storage.conversation(ROOT_CONVERSATION_ID, context)).toBeUndefined()
    await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context)
    await storage.close(context)
  })

  it('rejects duplicate namespace owners and a second process-level owner', async () => {
    const { namespace, storage, codec } = await fixture()
    await expect(store.openNamespace(namespace, codec)).rejects.toThrow('already open')
    await expect(openPostgresRuntimeStore({ connectionString: databaseUrl! })).rejects.toThrow('already has')
    await storage.close(context)
  })

  it('holds reads behind an in-progress commit and drains admitted reads before namespace close', async () => {
    const codec = testCodec()
    const barrier = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const { storage } = await fixture({
      ...codec,
      encode: async (plaintext, address) => {
        entered.resolve()
        await barrier.promise
        return codec.encode(plaintext, address)
      },
    })
    const commit = storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context)
    await entered.promise
    const read = storage.conversation(ROOT_CONVERSATION_ID, context)
    const close = storage.close(context)
    barrier.resolve()
    await commit
    expect(await read).toEqual({ id: ROOT_CONVERSATION_ID })
    await close
    await expect(storage.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow('closed')
  })
  it('fails closed after the owner socket dies and only a new store can recover', async () => {
    const { namespace, storage, codec } = await fixture()
    await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], context)
    const owners = await sql<
      { pid: number }[]
    >`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'thunderbolt-cloud-runtime'`
    expect(owners).toHaveLength(1)
    await sql`SELECT pg_terminate_backend(${owners[0]!.pid})`
    await expect(storage.mintId()).rejects.toThrow()
    await expect(storage.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow()
    expect(fatalEvents).toHaveLength(1)
    await store.close()
    store = await openPostgresRuntimeStore({ connectionString: databaseUrl! })
    const reopened = await store.openNamespace(namespace, codec)
    expect(await reopened.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID })
    await reopened.close(context)
  })
})
