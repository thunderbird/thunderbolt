/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/config/settings'
import { user } from '@/db/auth-schema'
import { inferencePrices, inferenceUsage } from '@/db/inference-usage-schema'
import type { InferenceLogger } from '@/inference/client'
import type { InferenceDatabase } from '@/inference/usage-ledger'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { createTestDb } from '@/test-utils/db'
import { createMockAuth, mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { inferenceUsageReceiptHeader } from '@shared/inference-usage'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { verifyInferenceUsageReceipt } from '../inference/usage-receipt'
import { createTinfoilKeepWarm } from './keep-warm'
import { createTinfoilRoutes, type TinfoilProxyLatencyLog, type TinfoilProxyLogger } from './routes'
import { createTinfoilUpstreamOriginStore, type TinfoilUpstreamOriginStore } from './upstream-origin'

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>['db']

const enclaveUrl = 'https://inference.tinfoil.sh'
const testApiKey = 'test-tinfoil-key'
const receiptSecret = getSettings().betterAuthSecret
const upstreamTimeoutMessage = 'tinfoil upstream timeout'
const upstreamIdleTimeoutMessage = 'tinfoil upstream idle timeout'
const realFetch = (globalThis as Record<string, unknown>).__originalFetch as typeof fetch

const makeOkResponse = (body = 'ok', extraHeaders: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain', ...extraHeaders },
  })

/** Read the response body so capStream-style idle timers (if any) clear. */
const drain = async (res: Response): Promise<Response> => {
  if (res.body) {
    await res.arrayBuffer()
  }
  return res
}

/** Creates a fetch implementation whose pending request or response body follows its signal. */
const createAbortableFetch = (response?: Response) => {
  const started = Promise.withResolvers<AbortSignal>()
  const aborted = Promise.withResolvers<unknown>()
  const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal
    started.resolve(signal)

    if (!response) {
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => {
          aborted.resolve(signal.reason)
          reject(signal.reason)
        }
        signal.addEventListener('abort', rejectOnAbort, { once: true })
        if (signal.aborted) {
          rejectOnAbort()
        }
      })
    }

    const trackAbort = () => aborted.resolve(signal.reason)
    signal.addEventListener('abort', trackAbort, { once: true })
    if (signal.aborted) {
      trackAbort()
      return Promise.reject(signal.reason)
    }

    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }) ?? null
    return Promise.resolve(
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  }) as unknown as typeof fetch

  return { fetchFn, started: started.promise, aborted: aborted.promise }
}

const insertUser = async (database: TestDatabase, id: string, isAnonymous: boolean) => {
  await database.insert(user).values({
    id,
    name: isAnonymous ? 'Anonymous User' : 'Registered User',
    email: `${id}@example.com`,
    emailVerified: !isAnonymous,
    isAnonymous,
  })
}

describe('createTinfoilRoutes', () => {
  let mockFetch: ReturnType<typeof mock>
  let consoleSpies: ConsoleSpies
  let database: TestDatabase
  let cleanup: () => Promise<void>

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
    mockFetch = mock(() => Promise.resolve(makeOkResponse()))
  })

  afterAll(() => {
    consoleSpies.restore()
  })

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => Promise.resolve(makeOkResponse()))
    consoleSpies.error.mockClear()
  })

  afterEach(async () => {
    await cleanup()
  })

  const buildApp = (
    overrides: {
      apiKey?: string
      enclaveUrl?: string
      auth?: typeof mockAuth
      fetchFn?: typeof fetch
      logger?: TinfoilProxyLogger
      usageLogger?: InferenceLogger
      database?: InferenceDatabase
      nowFn?: () => number
      upstreamHeadersTimeoutMs?: number
      upstreamIdleTimeoutMs?: number
      upstreamOriginStore?: TinfoilUpstreamOriginStore
      captureInferenceErrorFn?: Parameters<typeof createTinfoilRoutes>[0]['captureInferenceErrorFn']
      rateLimit?: Parameters<typeof createTinfoilRoutes>[0]['rateLimit']
    } = {},
  ) =>
    new Elysia().use(
      createTinfoilRoutes({
        auth: overrides.auth ?? mockAuth,
        fetchFn: overrides.fetchFn ?? (mockFetch as unknown as typeof fetch),
        logger: overrides.logger,
        usageLogger: overrides.usageLogger,
        database: overrides.database ?? database,
        nowFn: overrides.nowFn,
        apiKey: overrides.apiKey ?? testApiKey,
        enclaveUrl: overrides.enclaveUrl ?? enclaveUrl,
        upstreamHeadersTimeoutMs: overrides.upstreamHeadersTimeoutMs,
        upstreamIdleTimeoutMs: overrides.upstreamIdleTimeoutMs,
        upstreamOriginStore: overrides.upstreamOriginStore,
        captureInferenceErrorFn: overrides.captureInferenceErrorFn,
        rateLimit: overrides.rateLimit,
      }),
    )

  describe('configuration', () => {
    it('returns 503 when the Tinfoil API key is not configured', async () => {
      const app = buildApp({ apiKey: '' })
      const res = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(res.status).toBe(503)
      expect(await res.text()).toBe('Tinfoil provider not configured')
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('method allowlist', () => {
    it.each(['PUT', 'DELETE', 'PATCH'])('returns 405 for disallowed method %s', async (method) => {
      const app = buildApp()
      const res = await app.handle(new Request('http://localhost/tinfoil/anything', { method, body: '' }))

      expect(res.status).toBe(405)
      expect(await res.text()).toBe('Method not allowed')
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('header handling', () => {
    it('rejects an authenticated x-api-key before rate limiting, admission, or upstream forwarding', async () => {
      let policySelectCalls = 0
      const rateLimitCalls = mock(() => {})
      const countingDatabase: InferenceDatabase = {
        insert: database.insert,
        select: ((fields) => {
          policySelectCalls += 1
          return database.select(fields)
        }) as InferenceDatabase['select'],
      }
      const rejectingRateLimit = new Elysia()
        .onBeforeHandle(({ set }) => {
          rateLimitCalls()
          set.status = 429
          return { error: 'Too many requests' }
        })
        .as('scoped')
      const app = buildApp({ database: countingDatabase, rateLimit: rejectingRateLimit })

      const response = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          headers: { 'x-api-key': 'valid-personal-access-token' },
          body: 'opaque-bytes',
        }),
      )
      const body = await response.text()

      expect(response.status).toBe(403)
      expect(JSON.parse(body)).toEqual({ error: { code: 'WEB_LOGIN_REQUIRED' } })
      expect(rateLimitCalls).not.toHaveBeenCalled()
      expect(policySelectCalls).toBe(0)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('strips inbound Authorization and injects the server bearer key', async () => {
      const app = buildApp()
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer client-supplied-secret',
              'content-type': 'application/octet-stream',
            },
            body: 'opaque-bytes',
          }),
        ),
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const sent = init.headers as Headers
      expect(sent.get('authorization')).toBe(`Bearer ${testApiKey}`)
      expect(sent.get('authorization')).not.toBe('Bearer client-supplied-secret')
    })

    it('strips hop-by-hop headers (cookie, host, connection)', async () => {
      const app = buildApp()
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: {
              cookie: 'session=abc',
              connection: 'keep-alive',
              host: 'client-supplied.example',
            },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const sent = init.headers as Headers
      expect(sent.get('cookie')).toBeNull()
      expect(sent.get('connection')).toBeNull()
      expect(sent.get('host')).toBeNull()
      expect(sent.get('x-tinfoil-request-usage-metrics')).toBeNull()
      expect(sent.get('te')).toBeNull()
      expect(sent.get('trailer')).toBeNull()
    })

    it('does not forward X-Tinfoil-Enclave-Url upstream', async () => {
      const app = buildApp()
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: { 'X-Tinfoil-Enclave-Url': 'https://router.inf6.tinfoil.sh' },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const sent = init.headers as Headers
      expect(sent.get('x-tinfoil-enclave-url')).toBeNull()
    })

    it('does not forward Thunderbolt client identity headers upstream', async () => {
      const app = buildApp()
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: {
              'X-App-Version': '1.2.3',
              'X-App-Language': 'de',
              'X-Device-ID': 'cli-device-id',
              'X-Device-Name': 'Workstation',
            },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      const sent = init.headers as Headers
      expect(sent.get('x-app-version')).toBeNull()
      expect(sent.get('x-app-language')).toBeNull()
      expect(sent.get('x-device-id')).toBeNull()
      expect(sent.get('x-device-name')).toBeNull()
    })

    it('strips response hop-by-hop headers while preserving content encoding', async () => {
      mockFetch.mockResolvedValueOnce(
        makeOkResponse('opaque', {
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
          'content-encoding': 'br',
        }),
      )
      const app = buildApp()

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(res.headers.get('connection')).toBeNull()
      expect(res.headers.get('transfer-encoding')).toBeNull()
      expect(res.headers.get('content-encoding')).toBe('br')
      await res.arrayBuffer()
    })

    it('strips upstream CORS headers so only our own middleware sets them', async () => {
      // The enclave emits a duplicated `Access-Control-Allow-Credentials: true, true`
      // that browsers reject; relaying any upstream access-control-* would fight
      // our cors() middleware.
      mockFetch.mockResolvedValueOnce(
        makeOkResponse('opaque', {
          'access-control-allow-credentials': 'true, true',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'X-Upstream-Only',
          'ehbp-response-nonce': 'abc123',
        }),
      )
      const app = buildApp()

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(res.headers.get('access-control-allow-credentials')).toBeNull()
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(res.headers.get('access-control-expose-headers')).toBeNull()
      expect(res.headers.get('ehbp-response-nonce')).toBe('abc123')
      await res.arrayBuffer()
    })
  })

  describe('body forwarding', () => {
    it('relays EHBP request and response bytes and headers unchanged', async () => {
      const requestPayload = new Uint8Array([0x00, 0xff, 0x01, 0x80])
      const responseChunks = [new Uint8Array([0xfe, 0x02]), new Uint8Array([0x00, 0x7f])]
      const requestBody = Promise.withResolvers<Uint8Array>()
      const requestEncapsulatedKey = Promise.withResolvers<string | null>()
      const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Headers
        const body = init?.body as ReadableStream<Uint8Array>
        requestEncapsulatedKey.resolve(headers.get('ehbp-encapsulated-key'))
        requestBody.resolve(new Uint8Array(await new Response(body).arrayBuffer()))

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of responseChunks) {
                controller.enqueue(chunk)
              }
              controller.close()
            },
          }),
          { headers: { 'Ehbp-Response-Nonce': 'response-nonce' } },
        )
      }) as unknown as typeof fetch
      const app = buildApp({ fetchFn })

      const res = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          headers: { 'Ehbp-Encapsulated-Key': 'encapsulated-key' },
          body: requestPayload,
        }),
      )

      expect(await requestBody.promise).toEqual(requestPayload)
      expect(await requestEncapsulatedKey.promise).toBe('encapsulated-key')
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xfe, 0x02, 0x00, 0x7f]))
      expect(res.headers.get('ehbp-response-nonce')).toBe('response-nonce')
      expect(res.headers.get(inferenceUsageReceiptHeader)).toMatch(/^iu1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    })

    it('forwards the request body for POST requests', async () => {
      const app = buildApp()
      const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04])

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: payload,
          }),
        ),
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${enclaveUrl}/v1/chat/completions`)
      expect(init.body).not.toBeNull()
      expect(init.method).toBe('POST')
      expect(init.redirect).toBe('manual')
      expect((init as RequestInit & { decompress: boolean }).decompress).toBeFalse()
      expect((init as RequestInit & { duplex: string }).duplex).toBe('half')
    })

    it('forwards JSON bodies untouched (parse: none keeps the stream intact)', async () => {
      const app = buildApp()
      const jsonBody = JSON.stringify({ model: 'glm-5-2', messages: [] })

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: jsonBody,
          }),
        ),
      )

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.body).not.toBeNull()
    })

    it('does not forward a body for GET requests', async () => {
      const app = buildApp()
      await drain(await app.handle(new Request('http://localhost/tinfoil/v1/models', { method: 'GET' })))

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(init.body).toBeNull()
    })
  })

  describe('managed GLM usage policy', () => {
    it.each([
      [
        'prefixed base',
        'https://inference.tinfoil.sh/v1',
        '/chat/completions?stream=true',
        'https://inference.tinfoil.sh/v1/chat/completions?stream=true',
      ],
      [
        'unprefixed base',
        'https://inference.tinfoil.sh',
        '/v1/chat/completions?stream=true',
        'https://inference.tinfoil.sh/v1/chat/completions?stream=true',
      ],
    ] as const)(
      'classifies the exact resolved POST pathname with a %s and preserves its query',
      async (_, base, path, expectedUrl) => {
        const userId = `managed-${_.replaceAll(' ', '-')}`
        const requestStartedAt = Math.floor(Date.now() / 1_000)
        const entries: Array<{ context: Parameters<InferenceLogger['info']>[0]; message: string }> = []
        const usageLogger: InferenceLogger = {
          info: (context, message) => entries.push({ context, message }),
        }
        const app = buildApp({
          auth: createMockAuth(userId, false),
          enclaveUrl: base,
          usageLogger,
        })

        const response = await app.handle(
          new Request(`http://localhost/tinfoil${path}`, {
            method: 'POST',
            headers: { 'X-Untrusted-Model': 'not-glm' },
            body: 'opaque-client-claims-another-model',
          }),
        )
        const requestFinishedAt = Math.floor(Date.now() / 1_000)

        const [upstreamUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
        expect(upstreamUrl).toBe(expectedUrl)
        const receipt = response.headers.get(inferenceUsageReceiptHeader)
        expect(receipt).not.toBeNull()
        if (!receipt) {
          return
        }
        expect(receipt).toMatch(/^iu1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
        const claims = verifyInferenceUsageReceipt(receipt, receiptSecret, Math.floor(Date.now() / 1_000))
        expect(claims).not.toBeNull()
        if (!claims) {
          return
        }
        expect(claims).toMatchObject({
          userId,
          provider: 'tinfoil',
          model: 'glm-5-2',
          inputNanoUsdPerToken: '1500',
          outputNanoUsdPerToken: '5250',
        })
        expect(claims.issuedAt).toBeGreaterThanOrEqual(requestStartedAt)
        expect(claims.issuedAt).toBeLessThanOrEqual(requestFinishedAt)
        expect(claims.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(entries).toEqual([
          {
            context: {
              event: 'inference_usage_receipt_issued',
              provider: 'tinfoil',
              model: 'glm-5-2',
              eventId: claims.eventId,
              route: '/tinfoil' + path.split('?')[0],
            },
            message: 'Inference usage receipt issued',
          },
        ])
        const serializedEntries = JSON.stringify(entries)
        expect(serializedEntries).not.toContain(receipt)
        expect(serializedEntries).not.toContain(userId)
        expect(serializedEntries).not.toContain('opaque-client')
        expect(serializedEntries).not.toContain('1500')
        expect(serializedEntries).not.toContain('5250')
        await response.arrayBuffer()
      },
    )

    it('classifies a percent-encoded equivalent pathname while preserving its URL bytes and query', async () => {
      const response = await buildApp().handle(
        new Request('http://localhost/tinfoil/v1/%63hat/completions?stream=true', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(response.headers.get(inferenceUsageReceiptHeader)).toMatch(/^iu1\./)
      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://inference.tinfoil.sh/v1/%63hat/completions?stream=true')
      await response.arrayBuffer()
    })

    it.each([
      ['GET', '/v1/chat/completions'],
      ['OPTIONS', '/v1/chat/completions'],
      ['POST', '/v1/chat/completions/'],
      ['POST', '/v1/%63hat/completions%'],
      ['POST', '/v1/chat/completion'],
      ['POST', '/v1/chat/completions-extra'],
      ['POST', '/chat/completions'],
      ['GET', '/v1/models'],
      ['POST', '/v1/audio/transcriptions'],
      ['POST', '/v1/audio/speech'],
      ['POST', '/v1/embeddings'],
    ] as const)('does not apply managed policy to %s %s', async (method, path) => {
      let policySelectCalls = 0
      const countingDatabase: InferenceDatabase = {
        insert: database.insert,
        select: ((fields) => {
          policySelectCalls += 1
          return database.select(fields)
        }) as InferenceDatabase['select'],
      }
      const request = new Request(`http://localhost/tinfoil${path}`, {
        method,
        body: method === 'POST' ? 'opaque-bytes' : undefined,
      })
      const response = await buildApp({ database: countingDatabase }).handle(request)

      expect(response.status).toBe(200)
      expect(response.headers.get(inferenceUsageReceiptHeader)).toBeNull()
      expect(policySelectCalls).toBe(0)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      await response.arrayBuffer()
    })

    it('returns the shared minimal 503 before fetch when the canonical price is missing', async () => {
      await database
        .delete(inferencePrices)
        .where(and(eq(inferencePrices.provider, 'tinfoil'), eq(inferencePrices.model, 'glm-5-2')))
      const app = buildApp()

      const response = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'INFERENCE_PRICE_UNAVAILABLE' } })
      expect(response.headers.get(inferenceUsageReceiptHeader)).toBeNull()
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it.each([
      ['anonymous', true, '5h', 10, 0],
      ['anonymous', true, '7d', 60, 6],
      ['registered', false, '5h', 1_500, 0],
      ['registered', false, '7d', 7_500, 6],
    ] as const)(
      'applies below, exact, and above %s %s quota boundaries before fetch',
      async (accountKind, isAnonymous, window, limitCents, ageHours) => {
        for (const [boundary, spentCents, expectedStatus] of [
          ['below', limitCents - 1, 200],
          ['exact', limitCents, 429],
          ['above', limitCents + 1, 429],
        ] as const) {
          const userId = `glm-${accountKind}-${window}-${boundary}`
          await insertUser(database, userId, isAnonymous)
          await database.insert(inferenceUsage).values({
            id: `${userId}-usage`,
            userId,
            provider: 'tinfoil',
            model: 'glm-5-2',
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            costNanoUsd: BigInt(spentCents) * 10_000_000n,
            createdAt: new Date(Date.now() - ageHours * 60 * 60 * 1_000),
          })
          const app = buildApp({ auth: createMockAuth(userId, isAnonymous) })
          const fetchCallsBefore = mockFetch.mock.calls.length

          const response = await app.handle(
            new Request('http://localhost/tinfoil/v1/chat/completions', {
              method: 'POST',
              body: 'opaque-bytes',
            }),
          )

          expect(response.status, boundary).toBe(expectedStatus)
          expect(mockFetch.mock.calls.length, boundary).toBe(
            expectedStatus === 200 ? fetchCallsBefore + 1 : fetchCallsBefore,
          )
          if (expectedStatus === 429) {
            expect(await response.json(), boundary).toEqual({
              error: { code: 'INFERENCE_QUOTA_EXCEEDED', window },
            })
            expect(response.headers.get(inferenceUsageReceiptHeader), boundary).toBeNull()
          } else {
            expect(response.headers.get(inferenceUsageReceiptHeader), boundary).not.toBeNull()
            await response.arrayBuffer()
          }
        }
      },
    )

    it('gives the five-hour window precedence when both quotas are exhausted', async () => {
      const userId = 'glm-both-windows'
      await insertUser(database, userId, false)
      await database.insert(inferenceUsage).values({
        id: 'glm-both-windows-usage',
        userId,
        provider: 'tinfoil',
        model: 'glm-5-2',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costNanoUsd: 75_000_000_000n,
      })

      const response = await buildApp({ auth: createMockAuth(userId, false) }).handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: '5h' } })
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it.each([300, 400, 429, 500])('does not issue or log a receipt for upstream status %s', async (status) => {
      const entries: Array<Parameters<InferenceLogger['info']>[0]> = []
      mockFetch.mockResolvedValueOnce(new Response('upstream failure', { status }))
      const response = await buildApp({
        usageLogger: { info: (context) => entries.push(context) },
      }).handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(response.status).toBe(status)
      expect(response.headers.get(inferenceUsageReceiptHeader)).toBeNull()
      expect(entries).toEqual([])
      await response.arrayBuffer()
    })

    it.each([
      ['a non-chat response', 'GET', '/v1/models', 200],
      ['a managed non-2xx response', 'POST', '/v1/chat/completions', 429],
    ] as const)('does not relay an upstream-supplied receipt on %s', async (_, method, path, status) => {
      mockFetch.mockResolvedValueOnce(
        new Response('upstream response', {
          status,
          headers: { [inferenceUsageReceiptHeader]: 'upstream-forged-receipt' },
        }),
      )

      const response = await buildApp().handle(
        new Request(`http://localhost/tinfoil${path}`, {
          method,
          body: method === 'POST' ? 'opaque-bytes' : undefined,
        }),
      )

      expect(response.headers.get(inferenceUsageReceiptHeader)).toBeNull()
      await response.arrayBuffer()
    })

    it('replaces an upstream-supplied receipt with the server-issued token on an exact managed 2xx', async () => {
      const forgedReceipt = 'upstream-forged-receipt'
      mockFetch.mockResolvedValueOnce(
        new Response('opaque response', {
          status: 200,
          headers: { [inferenceUsageReceiptHeader]: forgedReceipt },
        }),
      )

      const response = await buildApp().handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      const receipt = response.headers.get(inferenceUsageReceiptHeader)
      expect(receipt).not.toBeNull()
      expect(receipt).not.toBe(forgedReceipt)
      if (!receipt) {
        return
      }
      expect(verifyInferenceUsageReceipt(receipt, receiptSecret, Math.floor(Date.now() / 1_000))).toMatchObject({
        userId: 'test-user',
        provider: 'tinfoil',
        model: 'glm-5-2',
        inputNanoUsdPerToken: '1500',
        outputNanoUsdPerToken: '5250',
      })
      expect(await response.text()).toBe('opaque response')
    })

    it('keeps the request-start price snapshot when the current price changes during fetch', async () => {
      const fetchStarted = Promise.withResolvers<void>()
      const upstreamResponse = Promise.withResolvers<Response>()
      const fetchFn: typeof fetch = Object.assign(
        async () => {
          fetchStarted.resolve()
          return upstreamResponse.promise
        },
        { preconnect: globalThis.fetch.preconnect },
      )
      const responsePromise = buildApp({ fetchFn }).handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )
      await fetchStarted.promise
      await database
        .update(inferencePrices)
        .set({ inputNanoUsdPerToken: 9_999n, outputNanoUsdPerToken: 8_888n })
        .where(and(eq(inferencePrices.provider, 'tinfoil'), eq(inferencePrices.model, 'glm-5-2')))
      upstreamResponse.resolve(makeOkResponse())

      const response = await responsePromise
      const receipt = response.headers.get(inferenceUsageReceiptHeader)
      expect(receipt).not.toBeNull()
      if (!receipt) {
        return
      }
      const claims = verifyInferenceUsageReceipt(receipt, receiptSecret, Math.floor(Date.now() / 1_000))
      expect(claims).toMatchObject({
        inputNanoUsdPerToken: '1500',
        outputNanoUsdPerToken: '5250',
      })
      await response.arrayBuffer()
    })

    it('does not let usage logger failure alter a successful opaque response', async () => {
      const response = await buildApp({
        usageLogger: {
          info: () => {
            throw new Error('usage logger unavailable')
          },
        },
      }).handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get(inferenceUsageReceiptHeader)).toMatch(/^iu1\./)
      expect(await response.text()).toBe('ok')
    })
  })

  describe('upstream error telemetry', () => {
    const statusCases = [
      { status: 404, errorKind: 'bad_request' },
      { status: 422, errorKind: 'bad_request' },
      { status: 429, errorKind: 'rate_limit' },
      { status: 401, errorKind: 'auth' },
      { status: 500, errorKind: 'upstream_error' },
    ] as const

    for (const { status, errorKind } of statusCases) {
      it(`captures status ${status} as ${errorKind}`, async () => {
        const captureInferenceErrorMock = mock(() => {})
        mockFetch.mockResolvedValueOnce(new Response('enclave error', { status }))
        const app = buildApp({ captureInferenceErrorFn: captureInferenceErrorMock })

        const res = await drain(
          await app.handle(
            new Request('http://localhost/tinfoil/v1/chat/completions', { method: 'POST', body: 'sealed' }),
          ),
        )

        expect(res.status).toBe(status)
        expect(captureInferenceErrorMock).toHaveBeenCalledWith({
          provider: 'tinfoil',
          status,
          errorKind,
          subpath: '/v1/chat/completions',
          distinctId: 'test-user',
        })
      })
    }

    it('captures upstream fetch rejection as a connection failure', async () => {
      const captureInferenceErrorMock = mock(() => {})
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))
      const app = buildApp({ captureInferenceErrorFn: captureInferenceErrorMock })

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(res.status).toBe(500)
      expect(captureInferenceErrorMock).toHaveBeenCalledWith({
        provider: 'tinfoil',
        status: 500,
        errorKind: 'connection',
        subpath: '/v1/models',
        distinctId: 'test-user',
      })
    })

    it('captures upstream headers timeout as a connection failure', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const upstream = createAbortableFetch()
      const app = buildApp({
        captureInferenceErrorFn: captureInferenceErrorMock,
        fetchFn: upstream.fetchFn,
        upstreamHeadersTimeoutMs: 0,
      })

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(res.status).toBe(504)
      expect(captureInferenceErrorMock).toHaveBeenCalledWith({
        provider: 'tinfoil',
        status: 504,
        errorKind: 'connection',
        subpath: '/v1/models',
        distinctId: 'test-user',
      })
    })

    it('does not capture downstream client aborts', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const upstream = createAbortableFetch()
      const clientController = new AbortController()
      const app = buildApp({
        captureInferenceErrorFn: captureInferenceErrorMock,
        fetchFn: upstream.fetchFn,
      })
      const response = app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
          signal: clientController.signal,
        }),
      )

      await upstream.started
      clientController.abort()
      await response

      expect(captureInferenceErrorMock).not.toHaveBeenCalled()
    })

    it('captures one mid-stream idle timeout', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const firstChunk = new Uint8Array([0x01, 0xff])
      const upstream = createAbortableFetch(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(firstChunk)
            },
          }),
        ),
      )
      const app = buildApp({
        captureInferenceErrorFn: captureInferenceErrorMock,
        fetchFn: upstream.fetchFn,
        upstreamIdleTimeoutMs: 0,
      })

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))
      const reader = res.body!.getReader()

      expect(await reader.read()).toEqual({ done: false, value: firstChunk })
      await expect(reader.read()).rejects.toThrow(upstreamIdleTimeoutMessage)
      expect(captureInferenceErrorMock).toHaveBeenCalledTimes(1)
      expect(captureInferenceErrorMock).toHaveBeenCalledWith({
        provider: 'tinfoil',
        status: 504,
        errorKind: 'connection',
        subpath: '/v1/models',
        distinctId: 'test-user',
        phase: 'stream',
      })
    })

    it('does not capture a downstream client abort mid-stream', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const firstChunk = new Uint8Array([0x01, 0xff])
      const upstream = createAbortableFetch(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(firstChunk)
            },
          }),
        ),
      )
      const clientController = new AbortController()
      const app = buildApp({
        captureInferenceErrorFn: captureInferenceErrorMock,
        fetchFn: upstream.fetchFn,
        upstreamIdleTimeoutMs: 100,
      })
      const res = await app.handle(
        new Request('http://localhost/tinfoil/v1/models', {
          signal: clientController.signal,
        }),
      )
      const reader = res.body!.getReader()

      expect(await reader.read()).toEqual({ done: false, value: firstChunk })
      clientController.abort()
      await upstream.aborted
      await expect(reader.read()).rejects.toThrow()
      expect(captureInferenceErrorMock).not.toHaveBeenCalled()
    })

    it('does not capture 2xx enclave responses', async () => {
      const captureInferenceErrorMock = mock(() => {})
      const app = buildApp({ captureInferenceErrorFn: captureInferenceErrorMock })

      const res = await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/v1/chat/completions', { method: 'POST', body: 'sealed' }),
        ),
      )

      expect(res.status).toBe(200)
      expect(captureInferenceErrorMock).not.toHaveBeenCalled()
    })
  })

  describe('upstream timeouts and aborts', () => {
    it('returns 504 and aborts upstream when response headers time out', async () => {
      const upstream = createAbortableFetch()
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        upstreamHeadersTimeoutMs: 0,
      })

      const res = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(res.status).toBe(504)
      expect(res.headers.get(inferenceUsageReceiptHeader)).toBeNull()
      expect(res.headers.get('content-type')).toBe('text/plain')
      const body = await res.text()
      expect(body).toBe(upstreamTimeoutMessage)
      expect(await upstream.aborted).toBeInstanceOf(DOMException)
      expect(body).not.toContain(testApiKey)
    })

    it('errors a stalled response stream and aborts upstream', async () => {
      const firstChunk = new Uint8Array([0x01, 0xff])
      const upstream = createAbortableFetch(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(firstChunk)
            },
          }),
        ),
      )
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        upstreamIdleTimeoutMs: 0,
      })

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))
      const reader = res.body!.getReader()

      expect(await reader.read()).toEqual({ done: false, value: firstChunk })
      const stalledRead = reader.read()
      await expect(stalledRead).rejects.toThrow(upstreamIdleTimeoutMessage)
      await expect(stalledRead).rejects.not.toThrow(testApiKey)
      expect(await upstream.aborted).toBeInstanceOf(DOMException)
    })

    it('abruptly closes the socket when a relayed response stalls', async () => {
      const responseChunks = [new Uint8Array([0x01, 0x02]), new Uint8Array([0x03, 0x04])]
      const expectedBytes = new Uint8Array(responseChunks.flatMap((chunk) => [...chunk]))
      const upstream = createAbortableFetch(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of responseChunks) {
                controller.enqueue(chunk)
              }
            },
          }),
        ),
      )
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        upstreamIdleTimeoutMs: 20,
      })
      // Real socket via Elysia's own listen so the route receives the genuine
      // `ctx.server` — hand-wiring `app.server` would bypass the seam under test.
      await new Promise<void>((resolve) => {
        app.listen({ port: 0, hostname: '127.0.0.1' }, () => resolve())
      })

      try {
        const res = await realFetch(new URL('/tinfoil/v1/models', app.server!.url))
        const reader = res.body!.getReader()
        const receivedBytes: number[] = []

        while (receivedBytes.length < expectedBytes.byteLength) {
          const result = await reader.read()
          if (result.done) {
            throw new Error('response ended before relaying both upstream chunks')
          }
          receivedBytes.push(...result.value)
        }

        expect(new Uint8Array(receivedBytes)).toEqual(expectedBytes)
        await expect(reader.read()).rejects.toThrow()
        expect(await upstream.aborted).toBeInstanceOf(DOMException)
      } finally {
        await app.stop(true)
      }
    })

    it('aborts upstream when the client request aborts', async () => {
      const upstream = createAbortableFetch()
      const clientController = new AbortController()
      const app = buildApp({ fetchFn: upstream.fetchFn })
      const response = app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
          signal: clientController.signal,
        }),
      )

      await upstream.started
      clientController.abort()

      expect(await upstream.aborted).toBe(clientController.signal.reason)
      const resolvedResponse = await response
      expect(resolvedResponse.headers.get(inferenceUsageReceiptHeader)).toBeNull()
      expect(await resolvedResponse.text()).not.toContain(testApiKey)
    })

    it('keeps a steady response stream alive beyond the headers timeout', async () => {
      const chunks = [new Uint8Array([0x01]), new Uint8Array([0x02]), new Uint8Array([0x03]), new Uint8Array([0x04])]
      const upstream = createAbortableFetch(
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(chunk)
                await new Promise((resolve) => setImmediate(resolve))
              }
              controller.close()
            },
          }),
        ),
      )
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        upstreamHeadersTimeoutMs: 0,
        upstreamIdleTimeoutMs: 50,
      })

      const res = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]))
      await new Promise((resolve) => setImmediate(resolve))
      expect((await upstream.started).aborted).toBeFalse()
    })
  })

  describe('latency instrumentation', () => {
    it('logs and exposes pre-handler, fetch, and upstream-header phases', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [90, 100, 112, 152]
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const nowFn = () => {
        const timestamp = timestamps.shift()
        if (timestamp === undefined) {
          throw new Error('Unexpected timing read')
        }
        return timestamp
      }
      const app = buildApp({ logger, nowFn })

      const response = await drain(
        await app.handle(new Request('http://localhost/tinfoil/v1/models?request-secret=do-not-log')),
      )

      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/models',
            status: 200,
            preHandlerMs: 10,
            handlerToUpstreamFetchMs: 12,
            upstreamFetchToHeadersMs: 40,
            handlerToOutcomeMs: 52,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
      expect(response.headers.get('x-proxy-timing')).toBe('pre=10;fetch=12;headers=40')
      expect(response.headers.get('server-timing')).toBe('pre;dur=10, fetch;dur=12, headers;dur=40')
      expect(JSON.stringify(entries)).not.toContain('request-secret')
      expect(JSON.stringify(entries)).not.toContain(testApiKey)
    })

    it('logs one structured line for a request rejected before upstream fetch', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [5, 10, 13]
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const app = buildApp({
        apiKey: '',
        logger,
        nowFn: () => timestamps.shift() ?? 0,
      })

      const response = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(response.status).toBe(503)
      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/models',
            status: 503,
            preHandlerMs: 5,
            handlerToUpstreamFetchMs: null,
            upstreamFetchToHeadersMs: null,
            handlerToOutcomeMs: 3,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
    })

    it('logs exactly one 504 line when upstream headers time out', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [90, 100, 105, 135]
      const upstream = createAbortableFetch()
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        logger,
        nowFn: () => timestamps.shift() ?? 0,
        upstreamHeadersTimeoutMs: 0,
      })

      const response = await app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(response.status).toBe(504)
      expect(response.headers.get('x-proxy-timing')).toBe('pre=10;fetch=5;headers=na')
      expect(response.headers.get('server-timing')).toBe('pre;dur=10, fetch;dur=5')
      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/chat/completions',
            status: 504,
            preHandlerMs: 10,
            handlerToUpstreamFetchMs: 5,
            upstreamFetchToHeadersMs: null,
            handlerToOutcomeMs: 35,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
    })

    it('logs exactly one 499 line when the client aborts before upstream headers', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [5, 10, 12, 20]
      const upstream = createAbortableFetch()
      const clientController = new AbortController()
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const app = buildApp({
        fetchFn: upstream.fetchFn,
        logger,
        nowFn: () => timestamps.shift() ?? 0,
      })
      const response = app.handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
          signal: clientController.signal,
        }),
      )

      await upstream.started
      clientController.abort()
      await response

      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/chat/completions',
            status: 499,
            preHandlerMs: 5,
            handlerToUpstreamFetchMs: 2,
            upstreamFetchToHeadersMs: null,
            handlerToOutcomeMs: 10,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
      expect(entries.some(({ context }) => context.status === 500)).toBeFalse()
    })

    it('logs exactly one 500 line when upstream fetch rejects', async () => {
      const entries: Array<{ context: TinfoilProxyLatencyLog; message: string }> = []
      const timestamps = [5, 10, 12, 20]
      const logger: TinfoilProxyLogger = {
        info: (context, message) => entries.push({ context, message }),
      }
      const fetchFn = (async () => {
        throw new Error('Upstream connection failed')
      }) as unknown as typeof fetch
      const app = buildApp({
        fetchFn,
        logger,
        nowFn: () => timestamps.shift() ?? 0,
      })

      const response = await app.handle(new Request('http://localhost/tinfoil/v1/models'))

      expect(response.status).toBe(500)
      expect(entries).toEqual([
        {
          context: {
            event: 'tinfoil_proxy_latency',
            route: '/tinfoil/v1/models',
            status: 500,
            preHandlerMs: 5,
            handlerToUpstreamFetchMs: 2,
            upstreamFetchToHeadersMs: null,
            handlerToOutcomeMs: 10,
          },
          message: 'Tinfoil proxy latency',
        },
      ])
    })
  })

  describe('upstream URL derivation', () => {
    it('applies the configured API path prefix to the ATC-assigned enclave origin', async () => {
      const assignedEnclaveUrl = 'https://router.inf6.tinfoil.sh'
      const upstreamOriginStore = createTinfoilUpstreamOriginStore()
      const app = buildApp({ enclaveUrl: 'https://inference.tinfoil.sh/v1', upstreamOriginStore })

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/chat/completions?stream=true', {
            method: 'POST',
            headers: { 'X-Tinfoil-Enclave-Url': assignedEnclaveUrl },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${assignedEnclaveUrl}/v1/chat/completions?stream=true`)
      expect(upstreamOriginStore.get()).toBe(assignedEnclaveUrl)

      const keepWarmFetch = mock(() => Promise.resolve(makeOkResponse()))
      const keepWarm = createTinfoilKeepWarm(
        { tinfoilApiKey: testApiKey, tinfoilEnclaveUrl: 'https://inference.tinfoil.sh/v1' },
        {
          fetchFn: keepWarmFetch as unknown as typeof fetch,
          intervalMs: 100,
          logger: { debug: () => undefined },
          upstreamOriginStore,
        },
      )
      keepWarm.start()
      keepWarm.stop()

      expect(keepWarmFetch).toHaveBeenCalledWith(
        `${assignedEnclaveUrl}/v1/models`,
        expect.objectContaining({ method: 'GET' }),
      )
    })

    it('avoids a double slash when the assigned enclave origin has a trailing slash', async () => {
      const assignedEnclaveUrl = 'https://router.inf6.tinfoil.sh'
      const app = buildApp({ enclaveUrl: 'https://inference.tinfoil.sh/v1' })

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/chat/completions', {
            method: 'POST',
            headers: { 'X-Tinfoil-Enclave-Url': `${assignedEnclaveUrl}/` },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${assignedEnclaveUrl}/v1/chat/completions`)
    })

    it('does not add a path prefix when the configured enclave URL has none', async () => {
      const assignedEnclaveUrl = 'https://router.inf6.tinfoil.sh'
      const app = buildApp({ enclaveUrl: 'https://inference.tinfoil.sh' })

      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/chat/completions', {
            method: 'POST',
            headers: { 'X-Tinfoil-Enclave-Url': assignedEnclaveUrl },
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${assignedEnclaveUrl}/chat/completions`)
    })

    it.each(['https://sub.tinfoil.sh', 'https://tinfoil.sh'])(
      'accepts allowlisted assigned enclave URL %s',
      async (assignedEnclaveUrl) => {
        const app = buildApp()

        const response = await app.handle(
          new Request('http://localhost/tinfoil/v1/models', {
            headers: { 'X-Tinfoil-Enclave-Url': assignedEnclaveUrl },
          }),
        )

        expect(response.status).toBe(200)
        await drain(response)
        const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
        expect(calledUrl).toBe(`${assignedEnclaveUrl}/v1/models`)
      },
    )

    it.each(['http://inference.tinfoil.sh', 'https://evil-tinfoil.sh', 'https://tinfoil.sh.evil.com'])(
      'rejects non-allowlisted assigned enclave URL %s',
      async (assignedEnclaveUrl) => {
        const app = buildApp()

        const response = await app.handle(
          new Request('http://localhost/tinfoil/v1/models', {
            headers: { 'X-Tinfoil-Enclave-Url': assignedEnclaveUrl },
          }),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get('content-type')).toBe('text/plain')
        expect(response.headers.get('x-proxy-timing')).not.toBeNull()
        expect(await response.text()).toContain('Invalid X-Tinfoil-Enclave-Url')
        expect(mockFetch).not.toHaveBeenCalled()
      },
    )

    it('uses the configured enclave URL when no assignment header is provided', async () => {
      const fallbackEnclaveUrl = 'https://fallback.tinfoil.sh/v1'
      const app = buildApp({ enclaveUrl: fallbackEnclaveUrl })

      await drain(await app.handle(new Request('http://localhost/tinfoil/models')))

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${fallbackEnclaveUrl}/models`)
    })

    it('derives the upstream path from the wildcard, not the outer mount prefix', async () => {
      // Mount at a non-default outer prefix to prove the path comes from the wildcard.
      const app = new Elysia({ prefix: '/v2/alt' }).use(
        createTinfoilRoutes({
          auth: mockAuth,
          database,
          fetchFn: mockFetch as unknown as typeof fetch,
          apiKey: testApiKey,
          enclaveUrl,
        }),
      )

      await drain(
        await app.handle(
          new Request('http://localhost/v2/alt/tinfoil/v1/chat/completions?stream=true', {
            method: 'POST',
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${enclaveUrl}/v1/chat/completions?stream=true`)
    })

    it('strips trailing slash on the enclave URL before composing the upstream URL', async () => {
      const app = buildApp({ enclaveUrl: `${enclaveUrl}/` })
      await drain(await app.handle(new Request('http://localhost/tinfoil/v1/models', { method: 'GET' })))

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe(`${enclaveUrl}/v1/models`)
    })

    it('composes the upstream URL correctly when the enclave URL carries the /v1 API prefix', async () => {
      // Production wiring: TINFOIL_ENCLAVE_URL=https://inference.tinfoil.sh/v1,
      // and the SDK builds the request URL without an inner /v1 (its baseURL is
      // already <cloudUrl>/tinfoil, where cloudUrl ends in /v1).
      const app = buildApp({ enclaveUrl: 'https://inference.tinfoil.sh/v1' })
      await drain(
        await app.handle(
          new Request('http://localhost/tinfoil/chat/completions', {
            method: 'POST',
            body: 'opaque-bytes',
          }),
        ),
      )

      const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(calledUrl).toBe('https://inference.tinfoil.sh/v1/chat/completions')
    })
  })

  describe('authentication', () => {
    it('returns 401 when the session is null', async () => {
      const app = buildApp({ auth: mockAuthUnauthenticated })
      const res = await drain(await app.handle(new Request('http://localhost/tinfoil/v1/models', { method: 'GET' })))

      expect(res.status).toBe(401)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('returns 401 before managed policy for an unauthenticated exact chat request', async () => {
      let policySelectCalls = 0
      const countingDatabase: InferenceDatabase = {
        insert: database.insert,
        select: ((fields) => {
          policySelectCalls += 1
          return database.select(fields)
        }) as InferenceDatabase['select'],
      }
      const response = await buildApp({ auth: mockAuthUnauthenticated, database: countingDatabase }).handle(
        new Request('http://localhost/tinfoil/v1/chat/completions', {
          method: 'POST',
          body: 'opaque-bytes',
        }),
      )

      expect(response.status).toBe(401)
      expect(response.headers.get(inferenceUsageReceiptHeader)).toBeNull()
      expect(policySelectCalls).toBe(0)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })
})
