/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { getAllProviders, getProviderCredentials } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from '@/dal/test-utils'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { connectProvider, validateConnection } from './connect-provider'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

/** A fetch stub for a `models`-capable provider: lists one model, then accepts the 1-token completion. */
const okModelsFetch = (async (input: URL | RequestInfo) => {
  const url = typeof input === 'string' ? input : input.toString()
  if (url.includes('/chat/completions') || url.includes('/messages')) {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 })
  }
  return new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), { status: 200 })
}) as unknown as typeof fetch

const failingFetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch

describe('connectProvider', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('persists the provider row + secret and reports a passing validation', async () => {
    const db = getDb()
    const result = await connectProvider(
      { db, workspaceId: wsId, userId: testUserId, fetchFn: okModelsFetch },
      { type: 'openai', apiKey: 'sk-test' },
    )

    expect(result.validation.ok).toBe(true)

    const rows = await getAllProviders(db, wsId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: result.providerId, type: 'openai', enabledCapabilities: ['models'] })

    const credentials = await getProviderCredentials(db, result.providerId)
    expect(credentials).toEqual({ apiKey: 'sk-test' })
  })

  it('stores the base URL for url-type providers', async () => {
    const db = getDb()
    const result = await connectProvider(
      { db, workspaceId: wsId, userId: testUserId, fetchFn: okModelsFetch },
      { type: 'ollama', baseUrl: 'http://localhost:9999/v1' },
    )
    const rows = await getAllProviders(db, wsId)
    expect(rows[0]).toMatchObject({ id: result.providerId, type: 'ollama', baseUrl: 'http://localhost:9999/v1' })
  })

  it('keeps the connection but surfaces the error when validation fails', async () => {
    const db = getDb()
    const result = await connectProvider(
      { db, workspaceId: wsId, userId: testUserId, fetchFn: failingFetch },
      { type: 'openai', apiKey: 'sk-bad' },
    )
    expect(result.validation.ok).toBe(false)
    expect(await getAllProviders(db, wsId)).toHaveLength(1)
  })
})

describe('validateConnection', () => {
  it('validates the models capability for a model provider', async () => {
    const result = await validateConnection('openai', { apiKey: 'sk' }, okModelsFetch)
    expect(result.ok).toBe(true)
  })

  it('validates the search capability for a search provider', async () => {
    const okSearchFetch = (async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch
    const result = await validateConnection('exa', { apiKey: 'sk' }, okSearchFetch)
    expect(result.ok).toBe(true)
  })
})
