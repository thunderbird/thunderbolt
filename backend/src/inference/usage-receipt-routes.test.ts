/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { user } from '@/db/auth-schema'
import { inferencePrices, inferenceUsage } from '@/db/inference-usage-schema'
import { createTestDb } from '@/test-utils/db'
import { createMockAuth, createThrowingAuth, mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import {
  inferenceUsageReceiptPath,
  managedGlmIdentity,
  type InferenceUsageReceiptRequest,
} from '@shared/inference-usage'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { createHmac } from 'node:crypto'
import type { InferenceLogger } from './client'
import { createInferenceUsageReceiptRoutes } from './usage-receipt-routes'
import { issueInferenceUsageReceipt, type InferenceUsageReceiptClaims } from './usage-receipt'
import { maxPostgresInteger, type InferencePrice } from './usage-ledger'

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['db']
type TestApp = { handle: Elysia['handle'] }
type GlmPrice = InferencePrice & { provider: 'tinfoil'; model: 'glm-5-2' }
type TestReceiptBody = {
  receipt?: string | number | null
  promptTokens?: number | string | boolean | null
  completionTokens?: number | string | boolean | null
  totalTokens?: number | string | boolean | null
  eventId?: string
  userId?: string
  provider?: string
  model?: string
  inputNanoUsdPerToken?: string
  outputNanoUsdPerToken?: string
}
type TestSignedClaims = Omit<InferenceUsageReceiptClaims, 'provider' | 'model'> & {
  provider: string
  model: string
}
type CapturedLog = {
  context: Parameters<InferenceLogger['info']>[0]
  message: string
}

const secret = 'receipt-route-secret'
const nowSeconds = 1_787_616_000
const keyDomain = 'thunderbolt/inference-usage-receipt/key/v1'
const glmPrice: GlmPrice = {
  ...managedGlmIdentity,
  inputNanoUsdPerToken: 1_500n,
  outputNanoUsdPerToken: 5_250n,
}
const defaultCounts = { promptTokens: 10, completionTokens: 20, totalTokens: 30 }

const insertUser = async (database: TestDatabase, id: string) => {
  await database.insert(user).values({
    id,
    name: 'Receipt User',
    email: `${id}@example.com`,
    emailVerified: true,
    isAnonymous: false,
  })
}

const issueReceipt = (
  options: Readonly<{
    eventId?: string
    userId?: string
    price?: GlmPrice
    issuedAt?: number
  }> = {},
) =>
  issueInferenceUsageReceipt({
    eventId: options.eventId ?? crypto.randomUUID(),
    userId: options.userId ?? 'test-user',
    price: options.price ?? glmPrice,
    secret,
    nowSeconds: options.issuedAt ?? nowSeconds,
  })

const signTestClaims = (claims: TestSignedClaims): string => {
  const payloadSegment = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const key = createHmac('sha256', secret).update(keyDomain, 'utf8').digest()
  const signature = createHmac('sha256', key).update(`iu1.${payloadSegment}`, 'ascii').digest('base64url')
  return `iu1.${payloadSegment}.${signature}`
}

const postJson = (app: TestApp, body: TestReceiptBody, headers: Record<string, string> = {}) =>
  app.handle(
    new Request(`http://localhost/${inferenceUsageReceiptPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  )

const postRaw = (app: TestApp, body: string, headers: Record<string, string> = {}) =>
  app.handle(
    new Request(`http://localhost/${inferenceUsageReceiptPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    }),
  )

const expectEmptyResponse = async (response: Response, status: number) => {
  expect(response.status).toBe(status)
  expect(await response.text()).toBe('')
}

describe('inference usage receipt routes', () => {
  let app: TestApp
  let database: TestDatabase
  let cleanup: () => Promise<void>
  let logs: CapturedLog[]
  let logger: InferenceLogger

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
    await insertUser(database, 'test-user')
    await insertUser(database, 'another-user')
    logs = []
    logger = {
      info: mock((context, message) => {
        logs.push({ context, message })
      }),
    }
    app = new Elysia().use(
      createInferenceUsageReceiptRoutes({
        auth: mockAuth,
        database,
        secret,
        nowSeconds: () => nowSeconds,
        logger,
      }),
    )
  })

  afterEach(async () => {
    await cleanup()
  })

  it('preserves the existing unauthenticated 401 response', async () => {
    const unauthenticatedApp = new Elysia().use(
      createInferenceUsageReceiptRoutes({
        auth: mockAuthUnauthenticated,
        database,
        secret,
        nowSeconds: () => nowSeconds,
      }),
    )

    const response = await postJson(unauthenticatedApp, { receipt: issueReceipt(), ...defaultCounts })

    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
  })

  it('rejects an authenticated x-api-key before parsing the request body', async () => {
    const rateLimitCalls = mock(() => {})
    const rejectingRateLimit = new Elysia()
      .onBeforeHandle(({ set }) => {
        rateLimitCalls()
        set.status = 429
        return { error: 'Too many requests' }
      })
      .as('scoped')
    const rateLimitedApp = new Elysia().use(
      createInferenceUsageReceiptRoutes({
        auth: mockAuth,
        database,
        secret,
        nowSeconds: () => nowSeconds,
        rateLimit: rejectingRateLimit,
      }),
    )

    const response = await postRaw(rateLimitedApp, '{', { 'x-api-key': 'valid-personal-access-token' })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'WEB_LOGIN_REQUIRED' } })
    expect(rateLimitCalls).not.toHaveBeenCalled()
  })

  it('sanitizes an internal authentication error without exposing its raw message', async () => {
    const sensitiveMessage = 'sensitive auth provider internals'
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const errorApp = new Elysia().use(
      createInferenceUsageReceiptRoutes({
        auth: createThrowingAuth(new Error(sensitiveMessage)),
        database,
        secret,
        nowSeconds: () => nowSeconds,
      }),
    )

    try {
      const response = await postJson(errorApp, { receipt: issueReceipt(), ...defaultCounts })

      expect(response.status).toBe(500)
      expect(await response.text()).toBe('{"success":false,"data":null,"error":"Internal Server Error"}')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('composes under the main application prefix', async () => {
    const eventId = crypto.randomUUID()
    const prefixedApp = new Elysia({ prefix: '/v1' }).use(
      createInferenceUsageReceiptRoutes({
        auth: mockAuth,
        database,
        secret,
        nowSeconds: () => nowSeconds,
      }),
    )

    const response = await prefixedApp.handle(
      new Request(`http://localhost/v1/${inferenceUsageReceiptPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt: issueReceipt({ eventId }), ...defaultCounts }),
      }),
    )

    await expectEmptyResponse(response, 204)
    expect(await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))).toHaveLength(1)
  })

  it('stores identity and exact rates from the signed receipt and returns an empty 204', async () => {
    const eventId = crypto.randomUUID()
    const response = await postJson(app, { receipt: issueReceipt({ eventId }), ...defaultCounts })

    await expectEmptyResponse(response, 204)
    const [row] = await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))
    expect(row).toMatchObject({
      id: eventId,
      userId: 'test-user',
      provider: 'tinfoil',
      model: 'glm-5-2',
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      costNanoUsd: 120_000n,
    })
    expect(logs).toEqual([
      {
        context: {
          event: 'inference_usage_inserted',
          provider: 'tinfoil',
          model: 'glm-5-2',
          eventId,
          outcome: 'inserted',
        },
        message: 'Inference usage receipt stored',
      },
    ])
  })

  it('ignores unsigned body identity and price fields', async () => {
    const eventId = crypto.randomUUID()
    const response = await postJson(app, {
      receipt: issueReceipt({ eventId }),
      ...defaultCounts,
      eventId: 'attacker-event',
      userId: 'another-user',
      provider: 'anthropic',
      model: 'attacker-model',
      inputNanoUsdPerToken: '0',
      outputNanoUsdPerToken: '0',
    })

    await expectEmptyResponse(response, 204)
    const [row] = await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))
    expect(row).toMatchObject({
      id: eventId,
      userId: 'test-user',
      provider: 'tinfoil',
      model: 'glm-5-2',
      costNanoUsd: 120_000n,
    })
    expect(await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, 'attacker-event'))).toHaveLength(0)
  })

  it('rejects a valid receipt belonging to another authenticated user with an empty 403', async () => {
    const eventId = crypto.randomUUID()

    await expectEmptyResponse(
      await postJson(app, {
        receipt: issueReceipt({ eventId, userId: 'another-user' }),
        ...defaultCounts,
      }),
      403,
    )
    expect(await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))).toHaveLength(0)
  })

  it('rejects an authenticated JSON body larger than 4 KiB before receipt verification', async () => {
    const oversizedReceipt = signTestClaims({
      purpose: 'inference-usage-receipt',
      version: 1,
      eventId: crypto.randomUUID(),
      userId: 'u'.repeat(4_096),
      ...managedGlmIdentity,
      inputNanoUsdPerToken: '1500',
      outputNanoUsdPerToken: '5250',
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + 7_200,
    })
    const body = JSON.stringify({ receipt: oversizedReceipt, ...defaultCounts })
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(4_096)

    await expectEmptyResponse(await postRaw(app, body), 400)
  })

  it.each([
    ['missing receipt', { ...defaultCounts }],
    ['non-string receipt', { receipt: 123, ...defaultCounts }],
    ['missing prompt count', { receipt: issueReceipt(), completionTokens: 2, totalTokens: 3 }],
    ['string count', { receipt: issueReceipt(), promptTokens: '1', completionTokens: 2, totalTokens: 3 }],
    ['boolean count', { receipt: issueReceipt(), promptTokens: true, completionTokens: 2, totalTokens: 3 }],
    ['null count', { receipt: issueReceipt(), promptTokens: null, completionTokens: 2, totalTokens: 3 }],
    ['negative count', { receipt: issueReceipt(), promptTokens: -1, completionTokens: 2, totalTokens: 3 }],
    ['fractional count', { receipt: issueReceipt(), promptTokens: 1.5, completionTokens: 2, totalTokens: 3 }],
    [
      'unsafe count',
      { receipt: issueReceipt(), promptTokens: Number.MAX_SAFE_INTEGER + 1, completionTokens: 0, totalTokens: 0 },
    ],
    [
      'PostgreSQL integer overflow',
      { receipt: issueReceipt(), promptTokens: maxPostgresInteger + 1, completionTokens: 0, totalTokens: 0 },
    ],
  ])('rejects an invalid request body with an empty 400: %s', async (_name, body) => {
    await expectEmptyResponse(await postJson(app, body), 400)
  })

  it('rejects malformed JSON with an empty 400', async () => {
    await expectEmptyResponse(await postRaw(app, '{'), 400)
  })

  it('accepts a total count that differs from prompt plus completion', async () => {
    const eventId = crypto.randomUUID()
    const response = await postJson(app, {
      receipt: issueReceipt({ eventId }),
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 999,
    })

    await expectEmptyResponse(response, 204)
    const [row] = await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))
    expect(row).toMatchObject({ promptTokens: 1, completionTokens: 2, totalTokens: 999, costNanoUsd: 12_000n })
  })

  it.each([
    ['malformed', 'not-a-token'],
    [
      'tampered',
      (() => {
        const receipt = issueReceipt()
        const [prefix, payload, signature] = receipt.split('.') as [string, string, string]
        return `${prefix}.${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`
      })(),
    ],
    ['expired', issueReceipt({ issuedAt: nowSeconds - 7_200 })],
    ['future-issued', issueReceipt({ issuedAt: nowSeconds + 61 })],
    [
      'noncanonical provider',
      signTestClaims({
        purpose: 'inference-usage-receipt',
        version: 1,
        eventId: crypto.randomUUID(),
        userId: 'test-user',
        provider: 'anthropic',
        model: 'glm-5-2',
        inputNanoUsdPerToken: '1500',
        outputNanoUsdPerToken: '5250',
        issuedAt: nowSeconds,
        expiresAt: nowSeconds + 7_200,
      }),
    ],
    [
      'noncanonical model',
      signTestClaims({
        purpose: 'inference-usage-receipt',
        version: 1,
        eventId: crypto.randomUUID(),
        userId: 'test-user',
        provider: 'tinfoil',
        model: 'deepseek-v4-flash',
        inputNanoUsdPerToken: '1500',
        outputNanoUsdPerToken: '5250',
        issuedAt: nowSeconds,
        expiresAt: nowSeconds + 7_200,
      }),
    ],
  ])('maps an invalid receipt to an empty 400: %s', async (_name, receipt) => {
    await expectEmptyResponse(await postJson(app, { receipt, ...defaultCounts }), 400)
  })

  it('maps signed cost overflow to an empty 400 without inserting a row', async () => {
    const eventId = crypto.randomUUID()
    const overflowPrice: GlmPrice = {
      ...glmPrice,
      inputNanoUsdPerToken: 9_223_372_036_854_775_808n,
      outputNanoUsdPerToken: 0n,
    }

    await expectEmptyResponse(
      await postJson(app, {
        receipt: issueReceipt({ eventId, price: overflowPrice }),
        promptTokens: 1,
        completionTokens: 0,
        totalTokens: 1,
      }),
      400,
    )
    expect(await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))).toHaveLength(0)
  })

  it('uses signed request-start rates after the current GLM price changes', async () => {
    const eventId = crypto.randomUUID()
    const receipt = issueReceipt({ eventId })
    await database
      .update(inferencePrices)
      .set({ inputNanoUsdPerToken: 99_000n, outputNanoUsdPerToken: 199_000n })
      .where(and(eq(inferencePrices.provider, 'tinfoil'), eq(inferencePrices.model, 'glm-5-2')))

    await expectEmptyResponse(await postJson(app, { receipt, ...defaultCounts }), 204)
    const [row] = await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))
    expect(row.costNanoUsd).toBe(120_000n)
  })

  it('keeps first values on sequential replay and returns two empty 204 responses', async () => {
    const eventId = crypto.randomUUID()
    const receipt = issueReceipt({ eventId })
    const first = await postJson(app, { receipt, promptTokens: 1, completionTokens: 2, totalTokens: 3 })
    const duplicate = await postJson(app, { receipt, promptTokens: 99, completionTokens: 99, totalTokens: 99 })

    await expectEmptyResponse(first, 204)
    await expectEmptyResponse(duplicate, 204)
    const rows = await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ promptTokens: 1, completionTokens: 2, totalTokens: 3, costNanoUsd: 12_000n })
    expect(logs.map((entry) => entry.context)).toEqual([
      expect.objectContaining({ eventId, outcome: 'inserted' }),
      expect.objectContaining({ eventId, outcome: 'duplicate' }),
    ])
  })

  it('stores one row and returns two empty 204 responses under concurrent replay', async () => {
    const eventId = crypto.randomUUID()
    const body: InferenceUsageReceiptRequest = { receipt: issueReceipt({ eventId }), ...defaultCounts }
    const [first, second] = await Promise.all([postJson(app, body), postJson(app, body)])

    await expectEmptyResponse(first, 204)
    await expectEmptyResponse(second, 204)
    expect(await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))).toHaveLength(1)
  })

  it('reports unexpected persistence failures without exposing error details or changing the empty 503', async () => {
    const eventId = crypto.randomUUID()
    const receipt = issueReceipt({ eventId })
    const sensitivePrompt = 'private prompt text'
    const sensitiveCompletion = 'private completion text'
    const sensitiveMessage = 'database connection failed with private details'
    const sensitiveCause = { receipt, prompt: sensitivePrompt, completion: sensitiveCompletion }
    const persistenceError = new Error(sensitiveMessage, { cause: sensitiveCause })
    const insert = spyOn(database, 'insert').mockImplementation(() => {
      throw persistenceError
    })
    const capturedLogs: CapturedLog[] = []
    const throwingLogger: InferenceLogger = {
      info: (context, message) => {
        capturedLogs.push({ context, message })
        throw new Error('logger unavailable')
      },
    }
    const failureApp = new Elysia().use(
      createInferenceUsageReceiptRoutes({
        auth: mockAuth,
        database,
        secret,
        nowSeconds: () => nowSeconds,
        logger: throwingLogger,
      }),
    )

    try {
      await expectEmptyResponse(await postJson(failureApp, { receipt, ...defaultCounts }), 503)
    } finally {
      insert.mockRestore()
    }

    expect(capturedLogs).toEqual([
      {
        context: {
          event: 'inference_usage_callback_failed',
          provider: 'tinfoil',
          model: 'glm-5-2',
          route: `/${inferenceUsageReceiptPath}`,
        },
        message: 'Inference usage callback failed',
      },
    ])
    const serializedLogs = JSON.stringify(capturedLogs)
    expect(serializedLogs).not.toContain(receipt)
    expect(serializedLogs).not.toContain(sensitivePrompt)
    expect(serializedLogs).not.toContain(sensitiveCompletion)
    expect(serializedLogs).not.toContain(sensitiveMessage)
    expect(serializedLogs).not.toContain('cause')
    expect(Object.values(capturedLogs[0].context)).not.toContain(persistenceError)
    expect(Object.values(capturedLogs[0].context)).not.toContain(sensitiveCause)
  })

  it('returns an empty 503 on a real database failure without logging sensitive fields', async () => {
    const eventId = crypto.randomUUID()
    const receipt = issueReceipt({ eventId })
    await database.execute(sql`drop table inference_usage`)

    const response = await postJson(app, { receipt, ...defaultCounts })

    await expectEmptyResponse(response, 503)
    const serializedLogs = JSON.stringify(logs)
    expect(serializedLogs).not.toContain(receipt)
    expect(serializedLogs).not.toContain('test-user')
    expect(serializedLogs).not.toContain('1500')
    expect(serializedLogs).not.toContain('5250')
    expect(serializedLogs).not.toContain('120000')
    expect(serializedLogs).not.toContain('promptTokens')
  })

  it('does not let a logger failure change an inserted empty 204 response', async () => {
    const eventId = crypto.randomUUID()
    const throwingLogger: InferenceLogger = {
      info: () => {
        throw new Error('logger unavailable')
      },
    }
    const loggerFailureApp = new Elysia().use(
      createInferenceUsageReceiptRoutes({
        auth: createMockAuth('test-user'),
        database,
        secret,
        nowSeconds: () => nowSeconds,
        logger: throwingLogger,
      }),
    )

    await expectEmptyResponse(
      await postJson(loggerFailureApp, { receipt: issueReceipt({ eventId }), ...defaultCounts }),
      204,
    )
    expect(await database.select().from(inferenceUsage).where(eq(inferenceUsage.id, eventId))).toHaveLength(1)
  })
})
