/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { modelsTable } from '@/db/tables'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createFreeProxyFetch } from '@/lib/proxy-fetch'
import { targetUrlHeader, passthroughPrefixCased } from '@shared/proxy-protocol'
import { enableFreeModel, freeModelId, freeTierProviderId } from './free-model'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from '@/dal/test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})
afterAll(async () => {
  await teardownTestDatabase()
})

describe('enableFreeModel', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('creates a curated free model row marked with the free-tier sentinel', async () => {
    const db = getDb()
    const id = await enableFreeModel(db, wsId, testUserId)
    const rows = await db
      .select()
      .from(modelsTable)
      .where(and(eq(modelsTable.workspaceId, wsId), isNull(modelsTable.deletedAt)))
    const row = rows.find((r) => r.id === id)
    expect(row).toMatchObject({
      provider: 'openrouter',
      providerId: freeTierProviderId,
      model: freeModelId,
      enabled: 1,
    })
  })

  it('is idempotent — repeated calls return the same row', async () => {
    const db = getDb()
    const first = await enableFreeModel(db, wsId, testUserId)
    const second = await enableFreeModel(db, wsId, testUserId)
    expect(second).toBe(first)
    const rows = await db.select().from(modelsTable).where(eq(modelsTable.providerId, freeTierProviderId))
    expect(rows).toHaveLength(1)
  })
})

describe('createFreeProxyFetch', () => {
  it('routes to /v1/proxy/free with the target-URL header and no Authorization', async () => {
    let captured: Request | undefined
    const stub = (async (req: Request) => {
      captured = req
      // The free backend re-prefixes response headers; echo an empty ok.
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const freeFetch = createFreeProxyFetch('https://public.example.com', stub)
    await freeFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer should-be-dropped', 'content-type': 'application/json' },
      body: '{}',
    })

    expect(captured).toBeDefined()
    expect(captured!.url).toBe('https://public.example.com/v1/proxy/free')
    expect(captured!.headers.get(targetUrlHeader)).toBe('https://openrouter.ai/api/v1/chat/completions')
    // No bare Authorization leaks to the free endpoint; client auth is passthrough-prefixed only.
    expect(captured!.headers.get('authorization')).toBeNull()
    expect(captured!.headers.get(`${passthroughPrefixCased}content-type`)).toBe('application/json')
  })
})
