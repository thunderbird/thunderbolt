/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeEach, expect, it } from 'bun:test'
import { getDb } from '@/db/database'
import { resetTestDatabase, teardownTestDatabase } from './test-utils'
import { saveProviderConnection, getProviderCredentials, getProviderConnections } from './provider-connections'
import { exportUserData } from './export'
import { importUserData, ImportFormatError } from './import'
import { credentialBinding } from '@/providers/credentials'
import { modelsTable, modelsSecretsTable } from '@/db/tables'
import { migrateProviderConnections } from '@/lib/data-migrations/provider-connections'

beforeEach(resetTestDatabase)
afterAll(teardownTestDatabase)

it('backs up API keys and metadata while excluding all OAuth credentials', async () => {
  const id = await saveProviderConnection(getDb(), {
    provider: 'openai',
    name: 'Work',
    authMethod: 'api_key',
    credentials: { apiKey: 'test-api-key', access_token: 'must-not-export', refresh_token: 'must-not-export-either' },
  })
  await saveProviderConnection(getDb(), {
    provider: 'otari',
    name: 'Otari',
    authMethod: 'oauth',
    credentials: { access_token: 'oauth-access', refresh_token: 'oauth-refresh' },
  })
  const backup = await exportUserData(getDb(), { id: 'user', email: null })
  expect(backup.tables.provider_connections).toHaveLength(2)
  expect(backup.tables.provider_connection_secrets).toHaveLength(1)
  expect(JSON.stringify(backup)).toContain('test-api-key')
  for (const token of ['oauth-access', 'oauth-refresh', 'must-not-export']) {
    expect(JSON.stringify(backup)).not.toContain(token)
  }
  await resetTestDatabase()
  // JSON table order is not authoritative; metadata still precedes credential validation.
  const { provider_connection_secrets: connectionSecrets, ...metadataTables } = backup.tables
  const reordered = { ...backup, tables: { provider_connection_secrets: connectionSecrets, ...metadataTables } }
  await importUserData(getDb(), reordered, { id: 'other-user' })
  expect(await getProviderCredentials(getDb(), id)).toMatchObject({ apiKey: 'test-api-key' })
  expect(await getProviderCredentials(getDb(), 'oauth:otari')).toBeNull()
})

it('does not import OAuth tokens even if a backup explicitly includes them', async () => {
  await saveProviderConnection(getDb(), {
    provider: 'otari',
    name: 'Otari',
    authMethod: 'oauth',
    credentials: { access_token: 'original' },
  })
  const backup = await exportUserData(getDb(), { id: 'user', email: null })
  const metadata = (
    backup.tables.provider_connections as Array<{
      id: string
      provider: string
      authMethod: string
      url: string | null
    }>
  )[0]
  const forged = {
    ...backup,
    tables: {
      ...backup.tables,
      provider_connection_secrets: [
        {
          id: metadata.id,
          binding: credentialBinding(metadata),
          credentials: JSON.stringify({ access_token: 'forged', apiKey: 'forged' }),
        },
      ],
    },
  }
  await resetTestDatabase()
  await importUserData(getDb(), forged, { id: 'user' })
  expect(await getProviderCredentials(getDb(), 'oauth:otari')).toBeNull()
})

it('rejects a backup whose API key is bound to a different server', async () => {
  await saveProviderConnection(getDb(), {
    provider: 'custom',
    name: 'Local',
    url: 'http://localhost:11434/v1',
    authMethod: 'api_key',
    credentials: { apiKey: 'local-key' },
  })
  const backup = await exportUserData(getDb(), { id: 'user', email: null })
  const connection = backup.tables.provider_connections[0] as { url: string }
  connection.url = 'https://different.example/v1'
  await resetTestDatabase()
  await expect(importUserData(getDb(), backup, { id: 'user' })).rejects.toThrow('do not match')
})

it.each(['private-key-fragment', '{"apiKey":"private-key-fragment",}', '[]', 'null', '{"apiKey":42}'])(
  'rejects invalid credential JSON without exposing it and rolls back metadata',
  async (credentials) => {
    await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Work',
      authMethod: 'api_key',
      credentials: { apiKey: 'original' },
    })
    const backup = await exportUserData(getDb(), { id: 'user', email: null })
    const secret = backup.tables.provider_connection_secrets[0] as { credentials: string }
    secret.credentials = credentials
    await resetTestDatabase()
    const importing = importUserData(getDb(), backup, { id: 'user' })
    await expect(importing).rejects.toBeInstanceOf(ImportFormatError)
    await expect(importing).rejects.toThrow(/^Invalid provider API key backup\.$/)
    expect(await getProviderConnections(getDb())).toEqual([])
  },
)

const invalidMetadata: Array<[string, Record<string, unknown>]> = [
  ['unknown provider', { provider: 'unknown' }],
  ['unknown authentication method', { authMethod: 'password' }],
  ['non-string name', { name: { text: 'Work' } }],
  ['empty name', { name: ' ' }],
  ['non-string ID', { id: { value: 'id' } }],
  ['non-string URL', { url: { host: 'localhost' } }],
  ['missing custom endpoint', { url: null }],
  ['invalid URL', { url: 'not-a-url' }],
  ['non-HTTP URL', { url: 'file:///tmp/local' }],
  ['URL credentials', { url: 'https://user:secret@example.com/v1' }],
  ['URL query', { url: 'https://example.com/v1?key=secret' }],
  ['URL fragment', { url: 'https://example.com/v1#secret' }],
  ['unexpected fixed-provider URL', { provider: 'openai', url: 'https://example.com/v1' }],
  ['unsupported OAuth provider', { provider: 'anthropic', authMethod: 'oauth', id: 'oauth:anthropic', url: null }],
  [
    'noncanonical OAuth identity',
    { provider: 'otari', authMethod: 'oauth', id: 'other', url: 'https://example.com/api/v1' },
  ],
  ['reserved OAuth identity for an API key', { id: 'oauth:custom' }],
  ['unsupported Otari path', { provider: 'otari', url: 'https://example.com/not-the-api' }],
  ['non-numeric enabled flag', { enabled: '1' }],
  ['invalid modification time', { updatedAt: 'not-a-date' }],
  ['non-string modification time', { updatedAt: { value: 'today' } }],
]

it.each(invalidMetadata)('rejects %s in imported connections and rolls back all metadata', async (_label, values) => {
  await saveProviderConnection(getDb(), {
    provider: 'custom',
    name: 'Local',
    url: 'http://localhost:11434/v1',
    authMethod: 'api_key',
    credentials: {},
  })
  const backup = await exportUserData(getDb(), { id: 'user', email: null })
  const row = backup.tables.provider_connections[0] as Record<string, unknown>
  backup.tables.provider_connections = [
    { ...row, id: 'valid-first' },
    { ...row, ...values },
  ]
  await resetTestDatabase()
  await expect(importUserData(getDb(), backup, { id: 'user' })).rejects.toBeInstanceOf(ImportFormatError)
  expect(await getProviderConnections(getDb())).toEqual([])
})

it('round-trips a keyless local connection with nullable timestamps', async () => {
  const id = await saveProviderConnection(getDb(), {
    provider: 'custom',
    name: 'Local',
    url: 'http://localhost:11434/v1',
    authMethod: 'api_key',
    credentials: {},
  })
  const backup = await exportUserData(getDb(), { id: 'user', email: null })
  const metadata = backup.tables.provider_connections[0] as Record<string, unknown>
  metadata.createdAt = null
  metadata.updatedAt = null
  await resetTestDatabase()
  await importUserData(getDb(), backup, { id: 'user' })
  expect(await getProviderCredentials(getDb(), id)).toMatchObject({ apiKey: '' })
})

it('round-trips a migrated custom connection while retaining its noncanonical legacy model URL', async () => {
  const legacyUrl = ' http://localhost:11434/v1/ '
  await getDb().insert(modelsTable).values({
    id: 'legacy',
    provider: 'custom',
    name: 'Local',
    model: 'test',
    url: legacyUrl,
  })
  await getDb().insert(modelsSecretsTable).values({ modelId: 'legacy', apiKey: 'local-key' })
  await migrateProviderConnections(getDb())
  const backup = await exportUserData(getDb(), { id: 'user', email: null })
  expect(backup.tables.provider_connections).toMatchObject([{ url: 'http://localhost:11434/v1' }])
  expect(backup.tables.models).toMatchObject([{ url: legacyUrl }])
  await resetTestDatabase()
  await importUserData(getDb(), backup, { id: 'user' })
  expect(await getProviderCredentials(getDb(), 'legacy-model:legacy')).toMatchObject({ apiKey: 'local-key' })
})
