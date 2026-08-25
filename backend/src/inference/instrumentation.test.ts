/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache } from '@/config/settings'
import { user } from '@/db/auth-schema'
import { inferenceUsage } from '@/db/inference-usage-schema'
import { clearPostHogClient } from '@/posthog/client'
import { createTestDb } from '@/test-utils/db'
import { mockAuth } from '@/test-utils/mock-auth'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  clearInferenceClientCache,
  type InferenceLogger,
  type InferenceProxyLatencyLog,
  type InferenceUpstreamAttemptLog,
} from './client'
import { createInferenceRoutes } from './routes'

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['db']
type InferenceLog = Parameters<InferenceLogger['info']>[0]

const successfulStream =
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"test","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n' +
  'data: [DONE]\n\n'
const tinfoilEnclaveUrl = 'https://staging-inference.tinfoil.sh/v1/'

describe('inference attempt instrumentation', () => {
  let originalTinfoilApiKey: string | undefined
  let originalTinfoilEnclaveUrl: string | undefined
  let originalAnthropicApiKey: string | undefined
  let originalPostHogApiKey: string | undefined
  let database: TestDatabase
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
    await database.insert(user).values({
      id: 'test-user',
      name: 'Test User',
      email: 'test-user@example.com',
      emailVerified: true,
      isAnonymous: false,
    })
    originalTinfoilApiKey = process.env.TINFOIL_API_KEY
    originalTinfoilEnclaveUrl = process.env.TINFOIL_ENCLAVE_URL
    originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    originalPostHogApiKey = process.env.POSTHOG_API_KEY
    process.env.TINFOIL_API_KEY = 'test-tinfoil-key'
    process.env.TINFOIL_ENCLAVE_URL = tinfoilEnclaveUrl
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    delete process.env.POSTHOG_API_KEY
    clearSettingsCache()
    clearInferenceClientCache()
    clearPostHogClient()
  })

  afterEach(async () => {
    if (originalTinfoilApiKey === undefined) {
      delete process.env.TINFOIL_API_KEY
    } else {
      process.env.TINFOIL_API_KEY = originalTinfoilApiKey
    }
    if (originalTinfoilEnclaveUrl === undefined) {
      delete process.env.TINFOIL_ENCLAVE_URL
    } else {
      process.env.TINFOIL_ENCLAVE_URL = originalTinfoilEnclaveUrl
    }
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
    }
    if (originalPostHogApiKey === undefined) {
      delete process.env.POSTHOG_API_KEY
    } else {
      process.env.POSTHOG_API_KEY = originalPostHogApiKey
    }
    clearSettingsCache()
    clearInferenceClientCache()
    clearPostHogClient()
    await cleanup()
  })

  it.each([
    {
      model: 'deepseek-v4-flash',
      provider: 'tinfoil' as const,
      host: new URL(tinfoilEnclaveUrl).hostname,
      apiKey: 'test-tinfoil-key',
    },
    {
      model: 'opus-5',
      provider: 'anthropic' as const,
      host: 'api.anthropic.com',
      apiKey: 'test-anthropic-key',
    },
  ])('logs $provider 429 retry and surfaces attempts=2 after success', async ({ model, provider, host, apiKey }) => {
    const logs: Array<{ context: InferenceLog; message: string }> = []
    const upstreamBodies: string[] = []
    let callCount = 0
    const fetchFn = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount += 1
        upstreamBodies.push(await new Response(init?.body).text())
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '0',
              'X-RateLimit-Limit-Requests': '60',
              'X-RateLimit-Remaining-Requests': '0',
            },
          })
        }
        return new Response(successfulStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
      { preconnect: () => undefined },
    )
    const app = new Elysia().use(
      createInferenceRoutes({
        auth: mockAuth,
        database,
        fetchFn,
        logger: {
          info: (context, message) => logs.push({ context, message }),
        },
      }),
    )

    const response = await app.handle(
      new Request('http://localhost/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      }),
    )
    const responseText = await response.text()

    const attemptLogs = logs
      .map(({ context }) => context)
      .filter((context): context is InferenceUpstreamAttemptLog => context.event === 'inference_upstream_attempt')
    const latencyLogs = logs
      .map(({ context }) => context)
      .filter((context): context is InferenceProxyLatencyLog => context.event === 'inference_proxy_latency')

    expect(response.status).toBe(200)
    expect(callCount).toBe(2)
    expect(upstreamBodies).toHaveLength(2)
    expect(upstreamBodies.every((body) => body.includes('"stream_options":{"include_usage":true}'))).toBeTrue()
    expect(responseText).toContain('"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}')
    expect(response.headers.get('x-proxy-timing')).toContain('attempts=2')
    expect(attemptLogs).toHaveLength(2)
    expect(attemptLogs[0]).toMatchObject({
      provider,
      attempt: 1,
      method: 'POST',
      host,
      status: 429,
      retry_after: '0',
      rate_limit_headers: {
        'x-ratelimit-limit-requests': '60',
        'x-ratelimit-remaining-requests': '0',
      },
    })
    expect(attemptLogs[1]).toMatchObject({
      provider,
      attempt: 2,
      method: 'POST',
      host,
      status: 200,
    })
    expect(Object.hasOwn(attemptLogs[1], 'retry_after')).toBeFalse()
    expect(Object.hasOwn(attemptLogs[1], 'rate_limit_headers')).toBeFalse()
    expect(attemptLogs.every(({ duration_ms }) => duration_ms >= 0)).toBeTrue()
    expect(latencyLogs).toHaveLength(1)
    expect(latencyLogs[0]).toMatchObject({
      provider,
      status: 200,
      attempts: 2,
    })
    const rows = await database.select().from(inferenceUsage).where(eq(inferenceUsage.userId, 'test-user'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: 'test-user',
      provider,
      model: model === 'opus-5' ? 'claude-opus-5' : 'deepseek-v4-flash',
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
    })
    expect(JSON.stringify(logs)).not.toContain(apiKey)
    expect(JSON.stringify(logs)).not.toContain('Hello')
    expect(JSON.stringify(logs)).not.toContain('/v1/chat/completions')
  })
})
