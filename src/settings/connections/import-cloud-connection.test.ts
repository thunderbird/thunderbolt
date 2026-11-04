/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from '@/db/database'
import { applySchema } from '@/db/apply-schema'
import { getAllMcpServers, getMcpServerCredentials, updateMcpServerWithCredentials } from '@/dal'
import { connectionFixture } from '@/cloud-agent/connection-library-fixture'
import { importCloudMcpDefinition } from './import-cloud-connection'

const database = new Database()
beforeEach(async () => {
  await database.initialize({ type: 'bun-sqlite', path: ':memory:' })
  await applySchema(database.db)
})
afterEach(async () => {
  await database.close()
})

describe('explicit cloud definition import', () => {
  it('imports one disconnected library definition without copying a cloud credential, and safely retries', async () => {
    const connection = connectionFixture()
    const source = await importCloudMcpDefinition(database.db, connection)
    expect(source.id).toBe(connection.record.id)
    expect((await getAllMcpServers(database.db))[0]).toMatchObject({
      id: source.id,
      enabled: 0,
      name: connection.config.name,
      url: connection.config.url,
    })
    expect(await getMcpServerCredentials(database.db, source.id)).toBeNull()
    await updateMcpServerWithCredentials(database.db, source.id, {}, { type: 'bearer', token: 'device-only-token' })
    expect(await importCloudMcpDefinition(database.db, connection)).toEqual(source)
    expect(await getAllMcpServers(database.db)).toHaveLength(1)
    expect(await getMcpServerCredentials(database.db, source.id)).toEqual({
      type: 'bearer',
      token: 'device-only-token',
    })
  })
  it('does not overwrite a changed local definition or import a model as MCP', async () => {
    const connection = connectionFixture()
    await importCloudMcpDefinition(database.db, connection)
    await updateMcpServerWithCredentials(database.db, connection.record.id, { url: 'https://changed.example.com/mcp' })
    await expect(importCloudMcpDefinition(database.db, connection)).rejects.toThrow('already in use')
    await expect(
      importCloudMcpDefinition(database.db, { ...connection, config: { ...connection.config, kind: 'model' } }),
    ).rejects.toThrow('Models')
  })
})
