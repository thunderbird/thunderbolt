/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { providersSecretsTable, providersTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import {
  createProvider,
  deleteProvider,
  getAllProviders,
  getProviderCredentials,
  setProviderCredentials,
  updateProvider,
} from './providers'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Providers DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('createProvider / getAllProviders', () => {
    it('inserts a provider row scoped to the workspace', async () => {
      const db = getDb()
      const id = uuidv7()
      await createProvider(db, wsId, {
        id,
        type: 'openrouter',
        label: 'me@example.com',
        enabledCapabilities: ['models'],
        userId: testUserId,
      })

      const rows = await getAllProviders(db, wsId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id,
        type: 'openrouter',
        label: 'me@example.com',
        enabledCapabilities: ['models'],
        enabled: 1,
        scope: 'workspace',
      })
    })

    it('does not return providers from another workspace', async () => {
      const db = getDb()
      await createProvider(db, wsId, {
        id: uuidv7(),
        type: 'exa',
        enabledCapabilities: ['search'],
        userId: testUserId,
      })
      const rows = await getAllProviders(db, '99999999-0000-0000-0000-000000000000')
      expect(rows).toHaveLength(0)
    })
  })

  describe('updateProvider', () => {
    it('patches capabilities and label without touching type', async () => {
      const db = getDb()
      const id = uuidv7()
      await createProvider(db, wsId, {
        id,
        type: 'tinfoil',
        enabledCapabilities: ['models'],
        userId: testUserId,
      })

      await updateProvider(db, wsId, id, { enabledCapabilities: ['models', 'search'], label: 'work' })

      const rows = await getAllProviders(db, wsId)
      expect(rows[0].enabledCapabilities).toEqual(['models', 'search'])
      expect(rows[0].label).toBe('work')
      expect(rows[0].type).toBe('tinfoil')
    })

    it('is a no-op for an empty patch', async () => {
      const db = getDb()
      const id = uuidv7()
      await createProvider(db, wsId, { id, type: 'openai', enabledCapabilities: ['models'], userId: testUserId })
      await updateProvider(db, wsId, id, {})
      const rows = await getAllProviders(db, wsId)
      expect(rows).toHaveLength(1)
    })
  })

  describe('deleteProvider', () => {
    it('soft-deletes the metadata row and hard-deletes the credential', async () => {
      const db = getDb()
      const id = uuidv7()
      await createProvider(db, wsId, { id, type: 'openai', enabledCapabilities: ['models'], userId: testUserId })
      await setProviderCredentials(db, id, { apiKey: 'sk-test' })

      await deleteProvider(db, wsId, id)

      // Metadata soft-deleted (tombstone remains, filtered out of active query).
      const active = await getAllProviders(db, wsId)
      expect(active).toHaveLength(0)
      const all = await db.select().from(providersTable).where(eq(providersTable.id, id))
      expect(all).toHaveLength(1)
      expect(all[0].deletedAt).not.toBeNull()

      // Credential hard-deleted.
      expect(await getProviderCredentials(db, id)).toBeNull()
      const secretRows = await db.select().from(providersSecretsTable).where(eq(providersSecretsTable.providerId, id))
      expect(secretRows).toHaveLength(0)
    })
  })

  describe('credential helpers', () => {
    it('returns null when no credential row exists', async () => {
      expect(await getProviderCredentials(getDb(), uuidv7())).toBeNull()
    })

    it('round-trips an api-key credential', async () => {
      const db = getDb()
      const id = uuidv7()
      await setProviderCredentials(db, id, { apiKey: 'sk-abc' })
      expect(await getProviderCredentials(db, id)).toEqual({ apiKey: 'sk-abc' })
    })

    it('round-trips an oauth token credential', async () => {
      const db = getDb()
      const id = uuidv7()
      const cred = { access_token: 'a', refresh_token: 'r', expires_at: 1_900_000_000_000 }
      await setProviderCredentials(db, id, cred)
      expect(await getProviderCredentials(db, id)).toEqual(cred)
    })

    it('updates rather than duplicating an existing credential row', async () => {
      const db = getDb()
      const id = uuidv7()
      await setProviderCredentials(db, id, { apiKey: 'first' })
      await setProviderCredentials(db, id, { apiKey: 'second' })
      expect(await getProviderCredentials(db, id)).toEqual({ apiKey: 'second' })
      const rows = await db.select().from(providersSecretsTable).where(eq(providersSecretsTable.providerId, id))
      expect(rows).toHaveLength(1)
    })
  })
})
