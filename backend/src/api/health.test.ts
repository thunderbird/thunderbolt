/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { clearSettingsCache } from '@/config/settings'
import { createApp } from '@/index'
import type { ModelProbeFailure } from '@/inference/model-probe'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { createHealthRoutes } from './health'

const settings = createTestSettings({
  monitoringToken: 'test-monitoring-token',
  powersyncUrl: 'https://sync.example.com',
  resendApiKey: 'test-resend-key',
  anthropicApiKey: 'anthropic-test-key',
  tinfoilApiKey: 'tinfoil-test-key',
  tinfoilEnclaveUrl: 'https://inference.test/v1',
})
const headers = { Authorization: `Bearer ${settings.monitoringToken}` }
/** Builds an authorized request to a deep health route. */
const request = (route: string) => new Request(`http://localhost/health/${route}`, { headers })

describe('deep health', () => {
  let database: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testDb = await createTestDb()
    database = testDb.db
    cleanup = testDb.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  for (const route of ['database', 'powersync', 'email', 'models']) {
    it.each([
      ['', headers, 403, 'Monitoring token not configured'],
      [settings.monitoringToken, {}, 401, 'Unauthorized'],
      [settings.monitoringToken, { Authorization: 'Bearer invalid' }, 401, 'Unauthorized'],
      [settings.monitoringToken, { Authorization: 'Bearer test-monitoring-tokex' }, 401, 'Unauthorized'],
    ] as const)(
      `${route} rejects unauthorized callers before doing work (%s)`,
      async (token, authHeaders, status, error) => {
        const execute = mock(() => {
          throw new Error('database must not run')
        })
        const fetchFn = mock(async () => new Response())
        const probeModels = mock(async () => [])
        const app = createHealthRoutes({
          settings: { ...settings, monitoringToken: token },
          database: { execute, select: database.select.bind(database), insert: database.insert.bind(database) },
          fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
          probeModels,
        })
        const response = await app.handle(new Request(`http://localhost/health/${route}`, { headers: authHeaders }))
        expect(response.status).toBe(status)
        expect(await response.json()).toEqual({ error })
        expect(execute).not.toHaveBeenCalled()
        expect(fetchFn).not.toHaveBeenCalled()
        expect(probeModels).not.toHaveBeenCalled()
      },
    )
  }

  it('queries the database', async () => {
    const response = await createHealthRoutes({ settings, database }).handle(request('database'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it.each([
    [new Error('secret database details'), 'unreachable'],
    [new DOMException('secret timeout details', 'TimeoutError'), 'timeout'],
  ] as const)('sanitizes database errors (%s)', async (error, reason) => {
    const failingDatabase = {
      execute: () => {
        throw error
      },
      select: database.select.bind(database),
      insert: database.insert.bind(database),
    }
    const response = await createHealthRoutes({ settings, database: failingDatabase }).handle(request('database'))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'failed', reason })
  })

  it('bounds the database wait when execute never settles', async () => {
    const response = await createHealthRoutes({
      settings,
      database: {
        execute: new Proxy(database.execute, { apply: () => new Promise<never>(() => {}) }),
        select: database.select.bind(database),
        insert: database.insert.bind(database),
      },
      timeouts: { database: 5 },
    }).handle(request('database'))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'failed', reason: 'timeout' })
  })

  for (const route of ['powersync', 'email'] as const) {
    it(`${route} cancels the upstream request at its deadline`, async () => {
      const signals: AbortSignal[] = []
      const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init!.signal!
        signals.push(signal)
        return new Promise<Response>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      const response = await createHealthRoutes({
        settings,
        database,
        fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
        timeouts: { [route]: 5 },
      }).handle(request(route))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: 'failed', reason: 'timeout' })
      expect(signals).toHaveLength(1)
      expect(signals[0].aborted).toBe(true)
    })
    it(`${route} makes an authenticated read where required`, async () => {
      const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const outgoing = new Request(input, init)
        expect(outgoing.method).toBe('GET')
        expect(outgoing.url).toBe(
          route === 'email' ? 'https://api.resend.com/domains' : 'https://sync.example.com/probes/liveness',
        )
        expect(outgoing.headers.get('Authorization')).toBe(route === 'email' ? 'Bearer test-resend-key' : null)
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return new Response()
      })
      const response = await createHealthRoutes({
        settings,
        database,
        fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
      }).handle(request(route))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'ok' })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it.each([401, 403, 500])(`${route} reports HTTP %s`, async (status) => {
      const fetchFn = async () => new Response('secret upstream body', { status })
      const response = await createHealthRoutes({
        settings,
        database,
        fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
      }).handle(request(route))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        status: 'failed',
        reason: route === 'email' && status < 500 ? 'rejected' : `http-${status}`,
      })
    })

    it.each([
      [new Error('secret upstream details'), 'unreachable'],
      [new DOMException('secret timeout details', 'TimeoutError'), 'timeout'],
    ] as const)(`${route} sanitizes transport failures (%s)`, async (error, reason) => {
      const fetchFn = async () => {
        throw error
      }
      const response = await createHealthRoutes({
        settings,
        database,
        fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
      }).handle(request(route))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: 'failed', reason })
    })

    it(`${route} rejects missing configuration without a request`, async () => {
      const fetchFn = mock(async () => new Response())
      const response = await createHealthRoutes({
        settings: { ...settings, powersyncUrl: '', resendApiKey: '' },
        database,
        fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
      }).handle(request(route))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: 'failed', reason: 'not-configured' })
      expect(fetchFn).not.toHaveBeenCalled()
    })
  }

  it.each([
    { failures: [] },
    {
      failures: [
        { model: 'model-a', reason: 'no-text' },
        { model: 'model-b', reason: 'timeout' },
        { model: 'model-c', reason: 'upstream-error' },
        { model: 'model-d', reason: 'missing-price' },
      ],
    },
  ] satisfies { failures: ModelProbeFailure[] }[])('returns the catalog probe result (%j)', async ({ failures }) => {
    const probeModels = mock(async () => failures)
    const fetchFn = async () => new Response()
    const response = await createHealthRoutes({
      settings,
      database,
      fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
      probeModels,
    }).handle(request('models'))
    expect(response.status).toBe(failures.length ? 503 : 200)
    expect(await response.json()).toEqual(failures.length ? { status: 'failed', failures } : { status: 'ok' })
    expect(probeModels).toHaveBeenCalledWith({ settings, database, fetchFn, confidentialFetch: undefined })
  })

  it.each(['OK', ''])('wires models to the real catalog probe with confidential content %j', async (content) => {
    const seen: { model: string; authorization: string | null; transport: string }[] = []
    const fake = (transport: string, text: string) =>
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const outgoing = new Request(input, init)
          seen.push({
            model: (await outgoing.json()).model,
            authorization: outgoing.headers.get('authorization'),
            transport,
          })
          return Response.json({ choices: [{ message: { content: text } }] })
        },
        { preconnect: globalThis.fetch.preconnect },
      )
    const response = await createHealthRoutes({
      settings,
      database,
      fetchFn: fake('anthropic', 'OK'),
      confidentialFetch: fake('confidential', content),
    }).handle(request('models'))
    expect(response.status).toBe(content ? 200 : 503)
    expect(await response.json()).toEqual(
      content
        ? { status: 'ok' }
        : {
            status: 'failed',
            failures: [
              { model: 'deepseek-v4-flash', reason: 'no-text' },
              { model: 'glm-5-2', reason: 'no-text' },
            ],
          },
    )
    expect(seen.sort((a, b) => a.model.localeCompare(b.model))).toEqual([
      { model: 'claude-opus-5', authorization: `Bearer ${settings.anthropicApiKey}`, transport: 'anthropic' },
      { model: 'deepseek-v4-flash', authorization: `Bearer ${settings.tinfoilApiKey}`, transport: 'confidential' },
      { model: 'glm-5-2', authorization: `Bearer ${settings.tinfoilApiKey}`, transport: 'confidential' },
    ])
  })

  it('mounts deep health under /v1 and preserves unconditional liveness', async () => {
    const originalToken = process.env.MONITORING_TOKEN
    const originalVersion = process.env.MIN_APP_VERSION
    try {
      process.env.MONITORING_TOKEN = settings.monitoringToken
      process.env.MIN_APP_VERSION = '999.0.0'
      clearSettingsCache()
      const app = await createApp({
        database,
        fetchFn: Object.assign(async () => new Response(), { preconnect: globalThis.fetch.preconnect }),
      })
      const liveness = await app.handle(new Request('http://localhost/v1/health'))
      expect(liveness.status).toBe(200)
      expect(await liveness.json()).toEqual({ status: 'ok' })
      const deep = await app.handle(new Request('http://localhost/v1/health/database', { headers }))
      expect(deep.status).toBe(200)
      expect(await deep.json()).toEqual({ status: 'ok' })
      const rejected = await app.handle(new Request('http://localhost/v1/health/database'))
      expect(rejected.status).toBe(401)
      expect(await rejected.json()).toEqual({ error: 'Unauthorized' })
    } finally {
      if (originalToken === undefined) {
        delete process.env.MONITORING_TOKEN
      } else {
        process.env.MONITORING_TOKEN = originalToken
      }
      if (originalVersion === undefined) {
        delete process.env.MIN_APP_VERSION
      } else {
        process.env.MIN_APP_VERSION = originalVersion
      }
      clearSettingsCache()
    }
  })
})
