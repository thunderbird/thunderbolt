/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearSettingsCache } from '@/config/settings'
import { clearPostHogClient } from '@/posthog/client'
import { mockAuth } from '@/test-utils/mock-auth'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { clearInferenceClientCache, type InferenceUpstreamAttemptLog } from './client'
import { createInferenceRoutes, type InferenceProxyLatencyLog } from './routes'

type InferenceLog = InferenceUpstreamAttemptLog | InferenceProxyLatencyLog

const successfulStream =
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
  'data: [DONE]\n\n'

describe('inference attempt instrumentation', () => {
  let originalFireworksApiKey: string | undefined
  let originalAnthropicApiKey: string | undefined
  let originalPostHogApiKey: string | undefined

  beforeEach(() => {
    originalFireworksApiKey = process.env.FIREWORKS_API_KEY
    originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    originalPostHogApiKey = process.env.POSTHOG_API_KEY
    process.env.FIREWORKS_API_KEY = 'test-fireworks-key'
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    delete process.env.POSTHOG_API_KEY
    clearSettingsCache()
    clearInferenceClientCache()
    clearPostHogClient()
  })

  afterEach(() => {
    if (originalFireworksApiKey === undefined) {
      delete process.env.FIREWORKS_API_KEY
    } else {
      process.env.FIREWORKS_API_KEY = originalFireworksApiKey
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
  })

  it.each([
    {
      model: 'deepseek-v4-flash',
      provider: 'fireworks' as const,
      host: 'api.fireworks.ai',
      apiKey: 'test-fireworks-key',
    },
    {
      model: 'opus-4.8',
      provider: 'anthropic' as const,
      host: 'api.anthropic.com',
      apiKey: 'test-anthropic-key',
    },
  ])('logs $provider 429 retry and surfaces attempts=2 after success', async ({ model, provider, host, apiKey }) => {
    const logs: Array<{ context: InferenceLog; message: string }> = []
    let callCount = 0
    const fetchFn = (async () => {
      callCount += 1
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
    }) as unknown as typeof fetch
    const app = new Elysia().use(
      createInferenceRoutes({
        auth: mockAuth,
        fetchFn,
        logger: {
          info: (context, message) => logs.push({ context: context as InferenceLog, message }),
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
    await response.text()

    const attemptLogs = logs
      .map(({ context }) => context)
      .filter((context): context is InferenceUpstreamAttemptLog => context.event === 'inference_upstream_attempt')
    const latencyLogs = logs
      .map(({ context }) => context)
      .filter((context): context is InferenceProxyLatencyLog => context.event === 'inference_proxy_latency')

    expect(response.status).toBe(200)
    expect(callCount).toBe(2)
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
    expect(attemptLogs.every(({ duration_ms }) => duration_ms >= 0)).toBeTrue()
    expect(latencyLogs).toHaveLength(1)
    expect(latencyLogs[0]).toMatchObject({
      provider,
      status: 200,
      attempts: 2,
    })
    expect(JSON.stringify(logs)).not.toContain(apiKey)
    expect(JSON.stringify(logs)).not.toContain('Hello')
    expect(JSON.stringify(logs)).not.toContain('/inference/v1/chat/completions')
  })
})
