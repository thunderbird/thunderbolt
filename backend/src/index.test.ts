/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { clearSettingsCache } from '@/config/settings'
import { user } from '@/db/auth-schema'
import { inferencePrices } from '@/db/inference-usage-schema'
import { managedDirectRuntimes } from '@/inference/managed-models'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
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

describe('createApp hosted-agent wiring', () => {
  const agentModel = managedDirectRuntimes['opus-5-5'].internalName
  const agentEnv = {
    AGENT_ENABLED: 'true',
    AGENT_MODEL: agentModel,
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: 'https://anthropic.test',
  }
  let database: TestDatabase
  let cleanup: () => Promise<void>
  let savedEnv: Record<string, string | undefined>

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
    savedEnv = Object.fromEntries(Object.keys(agentEnv).map((name) => [name, process.env[name]]))
    Object.assign(process.env, agentEnv)
    clearSettingsCache()
  })

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
    clearSettingsCache()
    await cleanup()
  })

  it("routes the hosted agent's upstream calls through deps.fetchFn", async () => {
    const userId = 'create-app-agent-user'
    await database.insert(user).values({
      id: userId,
      name: 'Create App Agent User',
      email: 'create-app-agent@example.com',
      emailVerified: true,
      isAnonymous: false,
    })
    // A migration may already seed this row; admission only needs one to exist.
    await database
      .insert(inferencePrices)
      .values({ provider: 'anthropic', model: agentModel, inputNanoUsdPerToken: 1n, outputNanoUsdPerToken: 1n })
      .onConflictDoNothing()
    const fetchFn = mock(async (_input: RequestInfo | URL) =>
      Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'stub' } }, { status: 400 }),
    )
    const app = await createApp({
      database,
      auth: createHeaderAuth(userId),
      fetchFn: fetchFn as unknown as typeof fetch,
    })

    const response = await app.handle(
      new Request('http://localhost/v1/agent/chat', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'chat-1',
          messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
        }),
      }),
    )
    expect(response.status).toBe(200)
    await response.text()
    await Bun.sleep(10)

    expect(fetchFn.mock.calls.map(([input]) => String(input))).toContain('https://anthropic.test/v1/messages')
  })
})

it('does not expose the marketing contact endpoint on AI deployments', async () => {
  const { db: database, cleanup } = await createTestDb()
  try {
    const app = await createApp({ database })
    expect(app.routes.some((route) => route.path === '/v1/contact')).toBe(false)
    const response = await app.handle(
      new Request('http://localhost/v1/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.org' }),
      }),
    )
    expect(response.status).toBe(404)
  } finally {
    await cleanup()
  }
})
