/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { SecureClient } from 'tinfoil'
import { and, eq, sql } from 'drizzle-orm'
import { inferencePrices } from '@/db/schema'
import { resolveManagedDirectRuntime } from '@/inference/managed-models'
import { createTestDb } from '@/test-utils/db'
import { createTestSettings } from '@/test-utils/settings'
import { defaultModels } from '@shared/defaults/models'
import { probeCatalogModels } from './model-probe'

const confidentialModels = defaultModels
  .filter(({ provider, isConfidential }) => provider === 'tinfoil' && isConfidential === 1)
  .map(({ model }) => model)
const directModel = defaultModels.find(({ provider }) => provider === 'thunderbolt')!.model
const directWireModel = resolveManagedDirectRuntime(directModel)!.internalName

const settings = createTestSettings({
  anthropicApiKey: 'anthropic-test-key',
  tinfoilApiKey: 'tinfoil-test-key',
})
/** Build an OpenAI-compatible response without network access. */
const completion = (content: string | null | { type: string; text?: string }[] = 'OK') =>
  Response.json({ choices: [{ message: { content } }] })
/** Adapt request-oriented fakes to Bun's fetch contract. */
const transport = (handler: (request: Request) => Promise<Response>): typeof fetch =>
  Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
    preconnect: globalThis.fetch.preconnect,
  })

describe('probeCatalogModels', () => {
  let env: Awaited<ReturnType<typeof createTestDb>>
  beforeEach(async () => {
    env = await createTestDb()
  })
  afterEach(async () => {
    await env.cleanup()
  })

  it('checks every catalog model using the correct authenticated transport and tiny payload', async () => {
    const seen: string[] = []
    const fake = (key: string, models: string[]) =>
      transport(async (request) => {
        expect(new URL(request.url).host).toBe(key === settings.tinfoilApiKey ? 'attested.test' : 'api.anthropic.com')
        const body = await request.json()
        expect(models).toContain(body.model)
        expect(request.headers.get('authorization')).toBe(`Bearer ${key}`)
        expect(body).toMatchObject({
          max_tokens: 256,
          stream: false,
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        })
        expect(body.temperature).toBeUndefined()
        expect(body.thinking).toEqual(key === settings.tinfoilApiKey ? { type: 'disabled' } : undefined)
        seen.push(body.model)
        return completion()
      })
    expect(
      await probeCatalogModels({
        database: env.db,
        settings,
        fetchFn: fake(settings.anthropicApiKey, [directWireModel]),
        confidentialTransport: {
          fetch: fake(settings.tinfoilApiKey, confidentialModels),
          baseURL: 'https://attested.test/v1',
        },
      }),
    ).toEqual([])
    expect(seen.sort()).toEqual([directWireModel, ...confidentialModels].sort())
  })

  it.each(['https://anthropic.test', 'https://anthropic.test/'])(
    'uses the configured Anthropic API root %s',
    async (root) => {
      const urls: string[] = []
      expect(
        await probeCatalogModels({
          database: env.db,
          settings: { ...settings, anthropicBaseUrl: root },
          fetchFn: transport(async (request) => {
            urls.push(request.url)
            return completion()
          }),
          confidentialTransport: { fetch: transport(async () => completion()), baseURL: 'https://attested.test/v1' },
        }),
      ).toEqual([])
      expect(urls).toEqual(['https://anthropic.test/v1/chat/completions'])
    },
  )

  it.each(['failure', 'timeout'] as const)('bounds shared confidential initialization (%s)', async (kind) => {
    const ready = spyOn(SecureClient.prototype, 'ready').mockImplementation(async () => {
      if (kind === 'failure') {
        throw new TypeError('secret attestation details')
      }
      await new Promise<void>(() => {})
    })
    const logger = { warn: mock(() => {}) }
    const seen: string[] = []
    const fetchFn = transport(async (request) => {
      seen.push((await request.json()).model)
      return completion()
    })
    try {
      expect(await probeCatalogModels({ database: env.db, settings, fetchFn, logger, timeoutMs: 50 })).toEqual(
        confidentialModels.map((model) => ({ model, reason: kind === 'failure' ? 'upstream-error' : 'timeout' })),
      )
      expect(ready).toHaveBeenCalledTimes(1)
      expect(seen).toEqual([directWireModel])
      expect(logger.warn).toHaveBeenCalledTimes(confidentialModels.length)
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret attestation details')
      if (kind === 'failure') {
        expect(logger.warn).toHaveBeenCalledWith(
          {
            event: 'deep_health_model_probe_failed',
            model: confidentialModels[0],
            reason: 'upstream-error',
            errorName: 'TypeError',
          },
          'Model health probe failed',
        )
      }
    } finally {
      ready.mockRestore()
    }
  })

  it.each([404, 500])('sanitises HTTP %i and never retries', async (status) => {
    const logger = { warn: mock(() => {}) }
    const calls: string[] = []
    const fetchFn = transport(async (request) => {
      calls.push((await request.json()).model)
      return Response.json({ error: { message: 'secret upstream details' } }, { status })
    })
    expect(
      await probeCatalogModels({
        database: env.db,
        settings,
        logger,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      }),
    ).toEqual(defaultModels.map(({ model }) => ({ model, reason: 'upstream-error' })))
    expect(calls).toHaveLength(defaultModels.length)
    expect(logger.warn).toHaveBeenCalledTimes(defaultModels.length)
    for (const { model } of defaultModels) {
      expect(logger.warn).toHaveBeenCalledWith(
        { event: 'deep_health_model_probe_failed', model, reason: 'upstream-error', errorName: 'Error', status },
        'Model health probe failed',
      )
    }
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret upstream details')
  })

  it('sanitises thrown network errors', async () => {
    const logger = { warn: mock(() => {}) }
    const fetchFn = transport(async () => {
      throw new Error('secret network details')
    })
    expect(
      await probeCatalogModels({
        database: env.db,
        settings,
        logger,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      }),
    ).toEqual(defaultModels.map(({ model }) => ({ model, reason: 'upstream-error' })))
    expect(logger.warn).toHaveBeenCalledTimes(defaultModels.length)
    for (const { model } of defaultModels) {
      expect(logger.warn).toHaveBeenCalledWith(
        { event: 'deep_health_model_probe_failed', model, reason: 'upstream-error', errorName: 'Error' },
        'Model health probe failed',
      )
    }
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret network details')
  })

  it.each([
    { key: 'anthropicApiKey', value: '' },
    { key: 'anthropicApiKey', value: '  ' },
    { key: 'tinfoilApiKey', value: '' },
    { key: 'tinfoilApiKey', value: '  ' },
  ] as const)('skips providers with blank key %j', async ({ key, value }) => {
    const seen: string[] = []
    const logger = { warn: mock(() => {}) }
    const fetchFn = transport(async (request) => {
      seen.push((await request.json()).model)
      return completion()
    })
    const missing = key === 'anthropicApiKey' ? [directModel] : confidentialModels
    expect(
      await probeCatalogModels({
        database: env.db,
        settings: { ...settings, [key]: value },
        logger,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      }),
    ).toEqual(missing.map((model) => ({ model, reason: 'not-configured' })))
    expect(seen.sort()).toEqual((key === 'anthropicApiKey' ? [...confidentialModels] : [directWireModel]).sort())
    expect(logger.warn).toHaveBeenCalledTimes(missing.length)
  })

  it.each(['', '  ', null])('rejects empty text %j', async (content) => {
    const fetchFn = transport(async () => completion(content))
    expect(
      await probeCatalogModels({
        database: env.db,
        settings,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      }),
    ).toEqual(defaultModels.map(({ model }) => ({ model, reason: 'no-text' })))
  })

  it('joins text parts', async () => {
    const fetchFn = transport(async () =>
      completion([{ type: 'text', text: '' }, { type: 'image_url' }, { type: 'text', text: 'OK' }]),
    )
    expect(
      await probeCatalogModels({
        database: env.db,
        settings,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      }),
    ).toEqual([])
  })

  it('rejects all-empty text parts', async () => {
    const fetchFn = transport(async () =>
      completion([
        { type: 'text', text: '' },
        { type: 'text', text: '' },
      ]),
    )
    expect(
      await probeCatalogModels({
        database: env.db,
        settings,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      }),
    ).toEqual(defaultModels.map(({ model }) => ({ model, reason: 'no-text' })))
  })

  it('cancels timed-out upstream requests', async () => {
    const controllers: AbortController[] = []
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController()
      controllers.push(controller)
      return controller.signal
    })
    const started = Promise.withResolvers<void>()
    const signals: AbortSignal[] = []
    const fetchFn = transport(async (request) => {
      signals.push(request.signal)
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        if (signals.length === defaultModels.length) {
          started.resolve()
        }
      })
    })
    try {
      const result = probeCatalogModels({
        database: env.db,
        settings,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      })
      await started.promise
      for (const controller of controllers) {
        controller.abort(new DOMException('deadline', 'TimeoutError'))
      }
      expect(await result).toEqual(defaultModels.map(({ model }) => ({ model, reason: 'timeout' })))
      expect(signals).toHaveLength(defaultModels.length)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
    } finally {
      timeout.mockRestore()
    }
  })

  it('skips Anthropic when its price row is missing', async () => {
    await env.db
      .delete(inferencePrices)
      .where(and(eq(inferencePrices.provider, 'anthropic'), eq(inferencePrices.model, directWireModel)))
    const seen: string[] = []
    const fetchFn = transport(async (request) => {
      seen.push((await request.json()).model)
      return completion()
    })
    expect(
      await probeCatalogModels({
        database: env.db,
        settings,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      }),
    ).toEqual([{ model: directModel, reason: 'missing-price' }])
    expect(seen.sort()).toEqual([...confidentialModels].sort())
  })

  it('skips upstream calls for missing price rows', async () => {
    const missingModel = confidentialModels[0]
    await env.db.delete(inferencePrices).where(eq(inferencePrices.model, missingModel))
    const seen: string[] = []
    const fetchFn = transport(async (request) => {
      seen.push((await request.json()).model)
      return completion()
    })
    expect(
      await probeCatalogModels({
        database: env.db,
        settings,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      }),
    ).toEqual([{ model: missingModel, reason: 'missing-price' }])
    expect(seen).not.toContain(missingModel)
    expect(seen).toHaveLength(defaultModels.length - 1)
  })

  it('bounds the wait even when attestation ignores cancellation', async () => {
    const fetchFn = transport(async () => new Promise<Response>(() => {}))
    expect(
      await probeCatalogModels({
        database: env.db,
        settings,
        fetchFn,
        confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
        timeoutMs: 5,
      }),
    ).toEqual(defaultModels.map(({ model }) => ({ model, reason: 'timeout' })))
  })

  it('bounds concurrency', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const active = new Set<Request>()
    const fetchFn = transport(async (request) => {
      active.add(request)
      expect(active.size).toBe(1)
      started.resolve()
      await release.promise
      active.delete(request)
      return completion()
    })
    const result = probeCatalogModels({
      database: env.db,
      settings,
      fetchFn,
      confidentialTransport: { fetch: fetchFn, baseURL: 'https://attested.test/v1' },
      concurrency: 1,
    })
    await started.promise
    try {
      // Drain queued price reads while the first upstream request remains blocked.
      await env.db.execute(sql`select 1`)
      expect(active.size).toBe(1)
    } finally {
      release.resolve()
    }
    expect(await result).toEqual([])
  })
})
