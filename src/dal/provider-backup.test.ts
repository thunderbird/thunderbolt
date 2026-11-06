/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeEach, expect, it } from 'bun:test'
import { getDb } from '@/db/database'
import { resetTestDatabase, teardownTestDatabase } from './test-utils'
import { saveProviderConnection, getProviderCredentials } from './provider-connections'
import { exportUserData } from './export'
import { importUserData } from './import'
import { credentialBinding } from '@/providers/credentials'

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
