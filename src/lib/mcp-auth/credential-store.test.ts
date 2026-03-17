import { getDb } from '@/db/database'
import { mcpServersTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createCredentialStore, resetKeyCache } from './credential-store'
import { createBearerAuthHeaders } from './bearer-token-provider'
import type { McpCredential } from '@/types/mcp'

// Mock @tauri-apps/plugin-fs so getDeviceId returns a stable test value
mock.module('@tauri-apps/plugin-fs', () => ({
  readTextFile: async () => 'test-device-id',
  writeTextFile: async () => {},
  BaseDirectory: { AppData: 0 },
}))

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

const seedServer = async (serverId: string) => {
  const db = getDb()
  await db.insert(mcpServersTable).values({
    id: serverId,
    name: 'Test Server',
    type: 'http',
    url: 'http://localhost:3000',
    enabled: 1,
  })
}

describe('CredentialStore', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    resetKeyCache()
  })

  describe('save and load roundtrip', () => {
    it('roundtrips a bearer credential', async () => {
      const db = getDb()
      const serverId = uuidv7()
      await seedServer(serverId)

      const store = createCredentialStore(db)
      const credential: McpCredential = { type: 'bearer', token: 'my-secret-api-key' }

      await store.save(serverId, credential)
      const loaded = await store.load(serverId)

      expect(loaded).toEqual(credential)
    })

    it('roundtrips an OAuth credential', async () => {
      const db = getDb()
      const serverId = uuidv7()
      await seedServer(serverId)

      const store = createCredentialStore(db)
      const credential: McpCredential = {
        type: 'oauth',
        accessToken: 'access-token-abc',
        refreshToken: 'refresh-token-xyz',
        expiresAt: '2026-12-31T00:00:00.000Z',
        tokenType: 'bearer',
        scope: 'read write',
      }

      await store.save(serverId, credential)
      const loaded = await store.load(serverId)

      expect(loaded).toEqual(credential)
    })

    it('roundtrips an OAuth credential without optional fields', async () => {
      const db = getDb()
      const serverId = uuidv7()
      await seedServer(serverId)

      const store = createCredentialStore(db)
      const credential: McpCredential = {
        type: 'oauth',
        accessToken: 'access-token-only',
        tokenType: 'bearer',
      }

      await store.save(serverId, credential)
      const loaded = await store.load(serverId)

      expect(loaded).toEqual(credential)
    })

    it('does not store plaintext in the database column', async () => {
      const db = getDb()
      const serverId = uuidv7()
      await seedServer(serverId)

      const store = createCredentialStore(db)
      const token = 'super-secret-token'
      await store.save(serverId, { type: 'bearer', token })

      const rows = await db.select({ encryptedCredential: mcpServersTable.encryptedCredential }).from(mcpServersTable)

      const raw = rows[0]?.encryptedCredential ?? ''
      expect(raw).not.toContain(token)
      expect(raw).toContain('"iv"')
      expect(raw).toContain('"ciphertext"')
    })

    it('produces different ciphertexts for identical inputs (unique IV per call)', async () => {
      const db = getDb()
      const serverId1 = uuidv7()
      const serverId2 = uuidv7()
      await seedServer(serverId1)
      await seedServer(serverId2)

      const store = createCredentialStore(db)
      const credential: McpCredential = { type: 'bearer', token: 'same-token' }
      await store.save(serverId1, credential)
      await store.save(serverId2, credential)

      const rows = await db.select({ encryptedCredential: mcpServersTable.encryptedCredential }).from(mcpServersTable)

      const [enc1, enc2] = rows.map((r) => r.encryptedCredential)
      expect(enc1).not.toEqual(enc2)
    })
  })

  describe('load', () => {
    it('returns null for a server with no credential', async () => {
      const db = getDb()
      const serverId = uuidv7()
      await seedServer(serverId)

      const store = createCredentialStore(db)
      const result = await store.load(serverId)

      expect(result).toBeNull()
    })

    it('returns null for a non-existent server ID', async () => {
      const db = getDb()
      const store = createCredentialStore(db)
      const result = await store.load('non-existent-server-id')

      expect(result).toBeNull()
    })
  })

  describe('delete', () => {
    it('removes the credential from the server record', async () => {
      const db = getDb()
      const serverId = uuidv7()
      await seedServer(serverId)

      const store = createCredentialStore(db)
      await store.save(serverId, { type: 'bearer', token: 'to-be-deleted' })

      const beforeDelete = await store.load(serverId)
      expect(beforeDelete).not.toBeNull()

      await store.delete(serverId)

      const afterDelete = await store.load(serverId)
      expect(afterDelete).toBeNull()
    })

    it('does not throw when deleting a credential that does not exist', async () => {
      const db = getDb()
      const serverId = uuidv7()
      await seedServer(serverId)

      const store = createCredentialStore(db)
      await expect(store.delete(serverId)).resolves.toBeUndefined()
    })

    it('does not affect other servers when deleting', async () => {
      const db = getDb()
      const serverId1 = uuidv7()
      const serverId2 = uuidv7()
      await seedServer(serverId1)
      await seedServer(serverId2)

      const store = createCredentialStore(db)
      const credential: McpCredential = { type: 'bearer', token: 'keep-this' }
      await store.save(serverId1, credential)
      await store.save(serverId2, { type: 'bearer', token: 'delete-this' })

      await store.delete(serverId2)

      const server1Cred = await store.load(serverId1)
      const server2Cred = await store.load(serverId2)

      expect(server1Cred).toEqual(credential)
      expect(server2Cred).toBeNull()
    })
  })
})

describe('createBearerAuthHeaders', () => {
  it('produces correct Authorization header format', () => {
    const headers = createBearerAuthHeaders('my-token')
    expect(headers).toEqual({ Authorization: 'Bearer my-token' })
  })

  it('handles tokens with special characters', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.payload.signature'
    const headers = createBearerAuthHeaders(token)
    expect((headers as Record<string, string>)['Authorization']).toBe(`Bearer ${token}`)
  })
})
