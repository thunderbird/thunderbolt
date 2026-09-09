/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { getSettings } from '@/config/settings'
import { user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { issueInferenceUsageReceipt } from '@/inference/usage-receipt'
import { createTestDb } from '@/test-utils/db'
import { inferenceUsageReceiptHeader, inferenceUsageReceiptPath } from '@shared/inference-usage'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createApp } from './index'

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['db']

const createHeaderAuth = (userId: string): Auth => {
  const auth = {
    api: {
      getSession: ({ headers }: { headers: Headers }) =>
        Promise.resolve(headers.get('Authorization') === 'Bearer valid' ? { user: { id: userId }, session: {} } : null),
    },
  }
  return auth as Auth
}

describe('createApp inference receipt wiring', () => {
  let database: TestDatabase
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  it('mounts one authenticated receipt endpoint and exposes its response header through CORS', async () => {
    const userId = 'create-app-receipt-user'
    const eventId = crypto.randomUUID()
    await database.insert(user).values({
      id: userId,
      name: 'Create App Receipt User',
      email: 'create-app-receipt@example.com',
      emailVerified: true,
      isAnonymous: false,
    })
    const receipt = issueInferenceUsageReceipt({
      eventId,
      userId,
      price: {
        provider: 'tinfoil',
        model: 'glm-5-2',
        inputNanoUsdPerToken: 1_500n,
        outputNanoUsdPerToken: 5_250n,
      },
      secret: getSettings().betterAuthSecret,
      nowSeconds: Math.floor(Date.now() / 1_000),
    })
    const app = await createApp({ database, auth: createHeaderAuth(userId) })
    const path = `/v1/${inferenceUsageReceiptPath}`
    const requestBody = JSON.stringify({ receipt, promptTokens: 10, completionTokens: 20, totalTokens: 30 })

    const unauthenticated = await app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      }),
    )
    const authenticated = await app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid',
          'Content-Type': 'application/json',
          Origin: 'http://localhost:1420',
        },
        body: requestBody,
      }),
    )

    const exposedHeaders =
      authenticated.headers
        .get('Access-Control-Expose-Headers')
        ?.split(',')
        .map((header) => header.trim().toLowerCase()) ?? []

    expect(app.routes.filter((route) => route.path === path && route.method === 'POST')).toHaveLength(1)
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.text()).toBe('Unauthorized')
    expect(authenticated.status).toBe(204)
    expect(await authenticated.text()).toBe('')
    expect(authenticated.headers.get(inferenceUsageReceiptHeader)).toBeNull()
    expect(exposedHeaders).toContain(inferenceUsageReceiptHeader.toLowerCase())
    expect(await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))).toHaveLength(1)
  })
})
