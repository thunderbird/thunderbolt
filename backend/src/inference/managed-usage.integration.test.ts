/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAuth } from '@/auth/auth'
import { clearSettingsCache, getSettings } from '@/config/settings'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { inferencePrices, inferenceUsage } from '@/db/inference-usage-schema'
import { createInferenceRoutes } from '@/inference/routes'
import { createInferenceUsageReceiptRoutes } from '@/inference/usage-receipt-routes'
import { getSharedIsolatedTestDb } from '@/test-utils/db'
import { createTinfoilRoutes } from '@/tinfoil/routes'
import { inferenceUsageReceiptHeader, inferenceUsageReceiptPath } from '@shared/inference-usage'
import { expect, it } from 'bun:test'
import { asc, eq, inArray } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { createHmac } from 'node:crypto'
import { z } from 'zod'

type TokenCounts = Readonly<{ promptTokens: number; completionTokens: number; totalTokens: number }>
const directProviderBodySchema = z.object({
  model: z.string(),
  stream: z.literal(true),
  stream_options: z.object({ include_usage: z.literal(true) }),
})
type DirectProviderBody = z.infer<typeof directProviderBodySchema>
type ProviderCall = Readonly<{
  url: string
  method: string
  bodyBytes: Uint8Array
  bodyJson: DirectProviderBody | null
}>

// Official canonical SKU prices verified 2026-08-25.
// Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
// Canonical Anthropic model: https://platform.claude.com/docs/en/about-claude/models/overview
// Tinfoil prices: https://tinfoil.sh/pricing
// Canonical Tinfoil catalog: https://api.tinfoil.sh/api/config/models?paid=true
const officialPriceOracle = {
  'tinfoil/deepseek-v4-flash': { inputNanoUsdPerToken: 300n, outputNanoUsdPerToken: 700n },
  'anthropic/claude-opus-5': { inputNanoUsdPerToken: 5_000n, outputNanoUsdPerToken: 25_000n },
  'tinfoil/glm-5-2': { inputNanoUsdPerToken: 1_500n, outputNanoUsdPerToken: 5_250n },
} as const

const deepseekCounts = { promptTokens: 10_000, completionTokens: 10_000, totalTokens: 20_000 } as const
const opusCounts = { promptTokens: 5_000, completionTokens: 1_000, totalTokens: 6_000 } as const
const glmCounts = { promptTokens: 10_000, completionTokens: 5_000, totalTokens: 15_000 } as const
const betterAuthSecret = 'managed-usage-better-auth-secret-1234567890'
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Sign a raw session token exactly as Better Auth's bearer plugin expects. */
const signBearerToken = (token: string): string =>
  `${token}.${createHmac('sha256', betterAuthSecret).update(token).digest('base64')}`

/** Build raw OpenAI-compatible SSE with ordinary chunks, final usage, and provider termination. */
const createOpenAiSse = (id: string, model: string, counts: TokenCounts): string =>
  [
    {
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture ' }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: { content: 'response' }, finish_reason: 'stop' }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [],
      usage: {
        prompt_tokens: counts.promptTokens,
        completion_tokens: counts.completionTokens,
        total_tokens: counts.totalTokens,
      },
    },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('') + 'data: [DONE]\n\n'

it('accounts for all managed transports in one anonymous rolling quota', async () => {
  const { client, db: database } = await getSharedIsolatedTestDb()
  const suffix = crypto.randomUUID()
  const userId = `managed-usage-user-${suffix}`
  const otherUserId = `managed-usage-other-${suffix}`
  const sessionToken = `managed-usage-session-${suffix}`
  const signedBearerToken = signBearerToken(sessionToken)
  const sessionId = `managed-usage-session-row-${suffix}`
  const directTinfoilOrigin = 'https://direct-managed-fixture.tinfoil.sh/v1'
  const opaqueTinfoilOrigin = 'https://opaque-managed-fixture.tinfoil.sh/v1'
  const providerCalls: ProviderCall[] = []
  const glmRequestBytes = Uint8Array.from([0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255])
  const glmResponseBytes = Uint8Array.from([255, 238, 221, 204, 187, 170, 153, 136, 119, 102, 85, 68, 51, 34, 17, 0])
  const originalEnvironment = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    INFERENCE_QUOTA_ANONYMOUS_5H_CENTS: process.env.INFERENCE_QUOTA_ANONYMOUS_5H_CENTS,
    INFERENCE_QUOTA_ANONYMOUS_7D_CENTS: process.env.INFERENCE_QUOTA_ANONYMOUS_7D_CENTS,
    POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
    TINFOIL_API_KEY: process.env.TINFOIL_API_KEY,
    TINFOIL_ENCLAVE_URL: process.env.TINFOIL_ENCLAVE_URL,
  }

  process.env.ANTHROPIC_API_KEY = 'managed-usage-anthropic-fixture-key'
  process.env.BETTER_AUTH_SECRET = betterAuthSecret
  process.env.INFERENCE_QUOTA_ANONYMOUS_5H_CENTS = '10'
  process.env.INFERENCE_QUOTA_ANONYMOUS_7D_CENTS = '60'
  process.env.TINFOIL_API_KEY = 'managed-usage-tinfoil-fixture-key'
  process.env.TINFOIL_ENCLAVE_URL = directTinfoilOrigin
  delete process.env.POSTHOG_API_KEY
  clearSettingsCache()

  try {
    try {
      const now = new Date()
      await database.insert(userTable).values([
        {
          id: userId,
          name: 'Managed Usage Anonymous User',
          email: `${userId}@example.test`,
          emailVerified: false,
          isAnonymous: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: otherUserId,
          name: 'Managed Usage Other User',
          email: `${otherUserId}@example.test`,
          emailVerified: false,
          isAnonymous: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      await database.insert(sessionTable).values({
        id: sessionId,
        token: sessionToken,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
        userId,
        createdAt: now,
        updatedAt: now,
      })
      await database.insert(inferenceUsage).values({
        id: `managed-usage-other-spend-${suffix}`,
        userId: otherUserId,
        provider: 'tinfoil',
        model: 'deepseek-v4-flash',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costNanoUsd: 100_000_000n,
      })

      const fetchFixture: typeof fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const request = input instanceof Request ? input.clone() : new Request(input, init)
          const bodyReader = request.clone()
          const bodyBytes = new Uint8Array(await request.arrayBuffer())
          const isOpaqueRequest = request.url === `${opaqueTinfoilOrigin}/chat/completions`
          const bodyText = !isOpaqueRequest
            ? bodyReader.headers.get('content-encoding') === 'gzip' && bodyReader.body
              ? await new Response(bodyReader.body.pipeThrough(new DecompressionStream('gzip'))).text()
              : new TextDecoder().decode(bodyBytes)
            : null
          const bodyJson = bodyText === null ? null : directProviderBodySchema.parse(JSON.parse(bodyText))
          providerCalls.push({ url: request.url, method: request.method, bodyBytes, bodyJson })

          if (request.url === `${directTinfoilOrigin}/chat/completions`) {
            return new Response(createOpenAiSse('chatcmpl-deepseek', 'deepseek-v4-flash', deepseekCounts), {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            })
          }
          if (request.url === 'https://api.anthropic.com/v1/chat/completions') {
            return new Response(createOpenAiSse('chatcmpl-opus', 'claude-opus-5', opusCounts), {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            })
          }
          if (isOpaqueRequest) {
            return new Response(glmResponseBytes.slice().buffer, {
              status: 200,
              headers: { 'Content-Type': 'application/octet-stream', 'Ehbp-Response-Nonce': 'fixture-nonce' },
            })
          }
          throw new Error(`Unexpected managed provider request: ${request.method} ${request.url}`)
        },
        { preconnect: () => undefined },
      )

      const settings = getSettings()
      expect(settings.inferenceQuotaAnonymousFiveHourCents).toBe(10)
      expect(settings.inferenceQuotaAnonymousSevenDayCents).toBe(60)
      const auth = createAuth(database)
      const app = new Elysia({ prefix: '/v1' })
        .use(
          createTinfoilRoutes({
            auth,
            database,
            fetchFn: fetchFixture,
            apiKey: 'opaque-managed-fixture-key',
            enclaveUrl: opaqueTinfoilOrigin,
          }),
        )
        .use(
          createInferenceUsageReceiptRoutes({
            auth,
            database,
            secret: settings.betterAuthSecret,
          }),
        )
        .use(
          createInferenceRoutes({
            auth,
            database,
            fetchFn: fetchFixture,
            isPostHogConfiguredFn: () => false,
          }),
        )
      const authenticatedJsonHeaders = {
        Authorization: `Bearer ${signedBearerToken}`,
        'Content-Type': 'application/json',
      }
      const wallClockStartedAt = new Date()
      const [{ recordedAt: databaseStartedAt }] = (
        await client.query<{ recordedAt: Date }>('select now() as "recordedAt"')
      ).rows

      const deepseekResponse = await app.handle(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: authenticatedJsonHeaders,
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: 'deepseek fixture' }],
            stream: true,
            stream_options: { include_usage: false, client_value: 'ignored' },
          }),
        }),
      )
      const deepseekBody = await deepseekResponse.text()
      expect(deepseekResponse.status).toBe(200)
      expect(deepseekBody).toContain('data: [DONE]\n\n')

      const opusResponse = await app.handle(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: authenticatedJsonHeaders,
          body: JSON.stringify({
            model: 'opus-5',
            messages: [{ role: 'user', content: 'opus fixture' }],
            stream: true,
            stream_options: { include_usage: false, client_value: 'ignored' },
          }),
        }),
      )
      const opusBody = await opusResponse.text()
      expect(opusResponse.status).toBe(200)
      expect(opusBody).toContain('data: [DONE]\n\n')

      const glmResponse = await app.handle(
        new Request('http://localhost/v1/tinfoil/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${signedBearerToken}`,
            'Content-Type': 'application/octet-stream',
            'X-Client-Model': 'client-metadata-cannot-select-the-managed-model',
          },
          body: glmRequestBytes.slice().buffer,
        }),
      )
      const receipt = glmResponse.headers.get(inferenceUsageReceiptHeader)
      const receivedGlmBytes = new Uint8Array(await glmResponse.arrayBuffer())
      expect(glmResponse.status).toBe(200)
      expect(receipt).toBeString()
      expect(receipt).not.toBeEmpty()
      expect(glmResponse.headers.has('Trailer')).toBe(false)
      expect(receivedGlmBytes).toEqual(glmResponseBytes)

      const receiptResponse = await app.handle(
        new Request(`http://localhost/v1/${inferenceUsageReceiptPath}`, {
          method: 'POST',
          headers: authenticatedJsonHeaders,
          body: JSON.stringify({
            receipt,
            ...glmCounts,
            provider: 'anthropic',
            model: 'client-metadata-cannot-select-the-managed-model',
            inputNanoUsdPerToken: '0',
            outputNanoUsdPerToken: '0',
          }),
        }),
      )
      expect(receiptResponse.status).toBe(204)
      expect(await receiptResponse.text()).toBe('')

      const fourthResponse = await app.handle(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: authenticatedJsonHeaders,
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: 'must be rejected before transport' }],
            stream: true,
          }),
        }),
      )
      expect(fourthResponse.status).toBe(429)
      expect(await fourthResponse.json()).toEqual({
        error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' },
      })
      expect(providerCalls).toHaveLength(3)

      const [{ recordedAt: databaseFinishedAt }] = (
        await client.query<{ recordedAt: Date }>('select now() as "recordedAt"')
      ).rows
      const wallClockFinishedAt = new Date()
      const usageRows = await database
        .select()
        .from(inferenceUsage)
        .where(eq(inferenceUsage.userId, userId))
        .orderBy(asc(inferenceUsage.provider), asc(inferenceUsage.model))

      expect(usageRows).toHaveLength(3)
      expect(
        usageRows.map(({ provider, model, promptTokens, completionTokens, totalTokens, costNanoUsd }) => ({
          provider,
          model,
          promptTokens,
          completionTokens,
          totalTokens,
          costNanoUsd,
        })),
      ).toEqual([
        {
          provider: 'anthropic',
          model: 'claude-opus-5',
          ...opusCounts,
          costNanoUsd: 50_000_000n,
        },
        {
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          ...deepseekCounts,
          costNanoUsd: 10_000_000n,
        },
        {
          provider: 'tinfoil',
          model: 'glm-5-2',
          ...glmCounts,
          costNanoUsd: 41_250_000n,
        },
      ])
      expect(usageRows.every(({ id }) => uuidV4Pattern.test(id))).toBe(true)
      expect(new Set(usageRows.map(({ id }) => id)).size).toBe(3)
      const intervalStartedAt = Math.min(wallClockStartedAt.getTime(), databaseStartedAt.getTime())
      const intervalFinishedAt = Math.max(wallClockFinishedAt.getTime(), databaseFinishedAt.getTime())
      expect(
        usageRows.every(({ createdAt }) => {
          const createdAtMs = createdAt.getTime()
          return createdAtMs >= intervalStartedAt && createdAtMs <= intervalFinishedAt
        }),
      ).toBe(true)

      const priceRows = await database
        .select()
        .from(inferencePrices)
        .orderBy(asc(inferencePrices.provider), asc(inferencePrices.model))
      expect(
        priceRows.map(({ provider, model, inputNanoUsdPerToken, outputNanoUsdPerToken }) => ({
          provider,
          model,
          inputNanoUsdPerToken,
          outputNanoUsdPerToken,
        })),
      ).toEqual([
        { provider: 'anthropic', model: 'claude-opus-5', ...officialPriceOracle['anthropic/claude-opus-5'] },
        {
          provider: 'tinfoil',
          model: 'deepseek-v4-flash',
          ...officialPriceOracle['tinfoil/deepseek-v4-flash'],
        },
        { provider: 'tinfoil', model: 'glm-5-2', ...officialPriceOracle['tinfoil/glm-5-2'] },
      ])

      const [{ totalCost }] = (
        await client.query<{ totalCost: string }>(
          'select coalesce(sum(cost_nano_usd), 0)::text as "totalCost" from inference_usage where user_id = $1',
          [userId],
        )
      ).rows
      expect(BigInt(totalCost)).toBe(101_250_000n)
      expect(providerCalls.map(({ url, method }) => ({ url, method }))).toEqual([
        { url: `${directTinfoilOrigin}/chat/completions`, method: 'POST' },
        { url: 'https://api.anthropic.com/v1/chat/completions', method: 'POST' },
        { url: `${opaqueTinfoilOrigin}/chat/completions`, method: 'POST' },
      ])
      expect(providerCalls[0].bodyJson).toMatchObject({
        model: 'deepseek-v4-flash',
        stream: true,
        stream_options: { include_usage: true },
      })
      expect(providerCalls[1].bodyJson).toMatchObject({
        model: 'claude-opus-5',
        stream: true,
        stream_options: { include_usage: true },
      })
      expect(providerCalls[2].bodyJson).toBeNull()
      expect(providerCalls[2].bodyBytes).toEqual(glmRequestBytes)

      const otherUserRows = await database.select().from(inferenceUsage).where(eq(inferenceUsage.userId, otherUserId))
      expect(otherUserRows).toHaveLength(1)
      expect(otherUserRows[0].costNanoUsd).toBe(100_000_000n)
    } finally {
      await database.delete(userTable).where(inArray(userTable.id, [userId, otherUserId]))
    }
  } finally {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
    clearSettingsCache()
  }
})
