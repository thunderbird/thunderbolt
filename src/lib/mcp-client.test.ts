/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createMcpServerWithCredentials } from '@/dal/mcp-servers'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { mcpServersTable } from '@/db/tables'
import { http } from './http'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { connectMcpClient } from './mcp-client'

const savedUrl = 'https://mcp.example.com/mcp'
const cloudUrl = 'https://cloud.example.com/v1'
const originalFetch = globalThis.fetch
let originalSettings = useLocalSettingsStore.getState()
const proxied: Array<{ target: string | null; authorization: string | null }> = []

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
  proxied.length = 0
  // The proxy hop only runs while the connected server is the one the client was built for.
  originalSettings = useLocalSettingsStore.getState()
  useLocalSettingsStore.setState({ cloudUrl, localMode: false })
  // Record the proxy hop and fail it, so the connect stops after the first request.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input)
      proxied.push({
        target: request.headers.get('X-Proxy-Target-Url'),
        authorization: request.headers.get('X-Proxy-Passthrough-Authorization'),
      })
      return new Response(null, { status: 503 })
    },
    { preconnect: originalFetch.preconnect },
  )
  await createMcpServerWithCredentials(
    getDb(),
    { id: 'mcp-1', name: 'Mine', type: 'http', url: savedUrl, enabled: 1 },
    { type: 'bearer', token: 'saved-token' },
  )
})

afterEach(() => {
  globalThis.fetch = originalFetch
  useLocalSettingsStore.setState(originalSettings)
})

const connect = (url: string) =>
  connectMcpClient({
    db: getDb(),
    httpClient: http,
    serverId: 'mcp-1',
    url,
    type: 'http',
    cloudUrl,
  }).catch(() => undefined)

it('reconnects to a server moved to another URL without its saved credential', async () => {
  const movedUrl = 'https://evil.example.com/mcp'
  await getDb().update(mcpServersTable).set({ url: movedUrl }).where(eq(mcpServersTable.id, 'mcp-1'))

  await connect(movedUrl)

  expect(proxied[0]).toEqual({ target: movedUrl, authorization: null })
})

it('does not send the credential to another path on the same host', async () => {
  const slashUrl = `${savedUrl}/`
  await getDb().update(mcpServersTable).set({ url: slashUrl }).where(eq(mcpServersTable.id, 'mcp-1'))

  await connect(slashUrl)

  expect(proxied[0]).toEqual({ target: slashUrl, authorization: null })
})

it('still authenticates the URL the credential was saved for', async () => {
  await connect(savedUrl)

  expect(proxied[0]).toEqual({ target: savedUrl, authorization: 'Bearer saved-token' })
})
