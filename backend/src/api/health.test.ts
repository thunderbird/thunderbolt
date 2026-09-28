/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { clearSettingsCache } from '@/config/settings'
import { createApp } from '@/index'
import { resolveManagedDirectRuntime } from '@/inference/managed-models'
import { emailFrom } from '@/lib/resend'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { defaultModels } from '@shared/defaults/models'
import { createHealthRoutes } from './health'

const directModel = defaultModels.find(({ provider }) => provider === 'thunderbolt')!.model
const directWireModel = resolveManagedDirectRuntime(directModel)!.internalName

const settings = createTestSettings({
  monitoringToken: 'test-monitoring-token',
  powersyncUrl: 'https://sync.example.com',
  resendMonitoringApiKey: 'test-resend-monitoring-key',
  anthropicApiKey: 'anthropic-test-key',
  tinfoilApiKey: 'tinfoil-test-key',
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

  for (const route of ['database', 'powersync', 'email', 'models', 'models?model=opus-5', 'models?model=unknown']) {
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
        const select = mock(() => {
          throw new Error('database must not run')
        })
        const app = createHealthRoutes({
          settings: { ...settings, monitoringToken: token },
          database: { execute, select, insert: database.insert.bind(database) },
          fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
        })
        const response = await app.handle(new Request(`http://localhost/health/${route}`, { headers: authHeaders }))
        expect(response.status).toBe(status)
        expect(await response.json()).toEqual({ error })
        expect(execute).not.toHaveBeenCalled()
        expect(fetchFn).not.toHaveBeenCalled()
        expect(select).not.toHaveBeenCalled()
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
        expect(outgoing.headers.get('Authorization')).toBe(
          route === 'email' ? 'Bearer test-resend-monitoring-key' : null,
        )
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return Response.json({ data: [{ name: emailFrom.split('@')[1], status: 'verified' }] })
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

    it.each([400, 401, 403, 500])(`${route} reports HTTP %s`, async (status) => {
      const fetchFn = async () =>
        Response.json({ name: status === 400 ? 'validation_error' : 'restricted_api_key' }, { status })
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
        settings: { ...settings, powersyncUrl: '', resendMonitoringApiKey: '' },
        database,
        fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
      }).handle(request(route))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: 'failed', reason: 'not-configured' })
      expect(fetchFn).not.toHaveBeenCalled()
    })
  }

  it.each([
    { data: [{ name: emailFrom.split('@')[1], status: 'pending' }] },
    { data: [{ name: 'other.example.com', status: 'verified' }] },
    { data: [] },
    { data: [{ name: emailFrom.split('@')[1] }] },
    {},
    null,
  ])('email requires a verified sending domain (%j)', async (body) => {
    const fetchFn = async () => Response.json(body)
    const response = await createHealthRoutes({
      settings,
      database,
      fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
    }).handle(request('email'))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'failed', reason: 'domain-unverified' })
  })

  it('email treats invalid JSON as an unverified domain', async () => {
    const fetchFn = async () => new Response('invalid JSON')
    const response = await createHealthRoutes({
      settings,
      database,
      fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
    }).handle(request('email'))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'failed', reason: 'domain-unverified' })
  })

  it.each(['', 'unknown', 'glm-5-2', 'toString', '<secret>'])(
    'rejects non-catalog selector %j without database or provider work',
    async (selector) => {
      const select = mock(() => {
        throw new Error('database must not run')
      })
      const fetchFn = mock(async () => new Response())
      const response = await createHealthRoutes({
        settings,
        database: { execute: database.execute.bind(database), insert: database.insert.bind(database), select },
        fetchFn: Object.assign(fetchFn, { preconnect: globalThis.fetch.preconnect }),
      }).handle(request(`models?model=${encodeURIComponent(selector)}`))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'Unknown catalog model' })
      expect(select).not.toHaveBeenCalled()
      expect(fetchFn).not.toHaveBeenCalled()
    },
  )

  for (const selector of [undefined, ...defaultModels.map(({ model }) => model)]) {
    it.each(['OK', '', 'upstream-error'])(
      `probes ${selector ?? 'the aggregate catalog'} with result %j`,
      async (content) => {
        const logger = { warn: mock(() => {}) }
        const seen: { model: string; authorization: string | null; transport: string }[] = []
        const fake = (transport: string) =>
          Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const outgoing = new Request(input, init)
              seen.push({
                model: (await outgoing.json()).model,
                authorization: outgoing.headers.get('authorization'),
                transport,
              })
              if (content === 'upstream-error') {
                return Response.json({ error: { message: 'secret upstream details' } }, { status: 429 })
              }
              return Response.json({ choices: [{ message: { content } }] })
            },
            { preconnect: globalThis.fetch.preconnect },
          )
        const response = await createHealthRoutes({
          settings,
          database,
          logger,
          fetchFn: fake('anthropic'),
          confidentialTransport: { fetch: fake('confidential'), baseURL: 'https://attested.test/v1' },
        }).handle(request(selector === undefined ? 'models' : `models?model=${selector}`))
        const selected = defaultModels.filter(({ model }) => selector === undefined || model === selector)
        expect(response.status).toBe(content === 'OK' ? 200 : 503)
        expect(await response.json()).toEqual(
          content === 'OK'
            ? { status: 'ok' }
            : {
                status: 'failed',
                failures: selected.map(({ model }) => ({
                  model,
                  reason: content === '' ? 'no-text' : 'upstream-error',
                  provider: model === directModel ? 'anthropic' : 'tinfoil',
                  upstreamModel: model === directModel ? directWireModel : model,
                  stage: 'completion',
                  elapsedMs: expect.any(Number),
                  upstreamStatus: content === '' ? 200 : 429,
                })),
              },
        )
        expect(logger.warn).toHaveBeenCalledTimes(content === 'OK' ? 0 : selected.length)
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret upstream details')
        expect(seen.sort((a, b) => a.model.localeCompare(b.model))).toEqual(
          selected
            .map(({ model }) => ({
              model: model === directModel ? directWireModel : model,
              authorization: `Bearer ${model === directModel ? settings.anthropicApiKey : settings.tinfoilApiKey}`,
              transport: model === directModel ? 'anthropic' : 'confidential',
            }))
            .sort((a, b) => a.model.localeCompare(b.model)),
        )
      },
    )
  }

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
