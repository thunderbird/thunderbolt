/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq } from 'drizzle-orm'
import { inferencePrices } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { defaultModels } from '@shared/defaults/models'
import { probeCatalogModels, type ModelProbeDeps } from './model-probe'

const settings: ModelProbeDeps['settings'] = {
  anthropicApiKey: 'anthropic-test-key',
  tinfoilApiKey: 'tinfoil-test-key',
  tinfoilEnclaveUrl: 'https://inference.test/v1',
}
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
        fetchFn: fake(settings.anthropicApiKey, ['claude-opus-5']),
        confidentialFetch: fake(settings.tinfoilApiKey, ['deepseek-v4-flash', 'glm-5-2']),
      }),
    ).toEqual([])
    expect(seen.sort()).toEqual(['claude-opus-5', 'deepseek-v4-flash', 'glm-5-2'])
  })

  it('sanitises confidential constructor failures while still probing Anthropic', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const seen: string[] = []
      const fetchFn = transport(async (request) => {
        seen.push((await request.json()).model)
        return completion()
      })
      expect(
        await probeCatalogModels({
          database: env.db,
          settings: { ...settings, tinfoilEnclaveUrl: 'ftp://test-user:test-password@example.test/v1' },
          fetchFn,
        }),
      ).toEqual([
        { model: 'deepseek-v4-flash', reason: 'upstream-error' },
        { model: 'glm-5-2', reason: 'upstream-error' },
      ])
      expect(seen).toEqual(['claude-opus-5'])
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it.each([404, 500])('sanitises HTTP %i and never retries', async (status) => {
    const calls: string[] = []
    const fetchFn = transport(async (request) => {
      calls.push((await request.json()).model)
      return Response.json({ error: { message: 'secret upstream details' } }, { status })
    })
    expect(await probeCatalogModels({ database: env.db, settings, fetchFn, confidentialFetch: fetchFn })).toEqual(
      defaultModels.map(({ model }) => ({ model, reason: 'upstream-error' })),
    )
    expect(calls).toHaveLength(defaultModels.length)
  })

  it('sanitises thrown network errors', async () => {
    const fetchFn = transport(async () => {
      throw new Error('secret network details')
    })
    expect(await probeCatalogModels({ database: env.db, settings, fetchFn, confidentialFetch: fetchFn })).toEqual(
      defaultModels.map(({ model }) => ({ model, reason: 'upstream-error' })),
    )
  })

  it.each(['', '  ', null])('rejects empty text %j', async (content) => {
    const fetchFn = transport(async () => completion(content))
    expect(await probeCatalogModels({ database: env.db, settings, fetchFn, confidentialFetch: fetchFn })).toEqual(
      defaultModels.map(({ model }) => ({ model, reason: 'no-text' })),
    )
  })

  it('joins text parts', async () => {
    const fetchFn = transport(async () => completion([{ type: 'text', text: 'OK' }]))
    expect(await probeCatalogModels({ database: env.db, settings, fetchFn, confidentialFetch: fetchFn })).toEqual([])
  })

  it('cancels timed-out upstream requests', async () => {
    const signals: AbortSignal[] = []
    const fetchFn = transport(async (request) => {
      signals.push(request.signal)
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    })
    expect(
      await probeCatalogModels({ database: env.db, settings, fetchFn, confidentialFetch: fetchFn, timeoutMs: 5 }),
    ).toEqual(defaultModels.map(({ model }) => ({ model, reason: 'timeout' })))
    expect(signals).toHaveLength(defaultModels.length)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('skips upstream calls for missing price rows', async () => {
    await env.db.delete(inferencePrices).where(eq(inferencePrices.model, 'deepseek-v4-flash'))
    const seen: string[] = []
    const fetchFn = transport(async (request) => {
      seen.push((await request.json()).model)
      return completion()
    })
    expect(await probeCatalogModels({ database: env.db, settings, fetchFn, confidentialFetch: fetchFn })).toEqual([
      { model: 'deepseek-v4-flash', reason: 'missing-price' },
    ])
    expect(seen).not.toContain('deepseek-v4-flash')
    expect(seen).toHaveLength(defaultModels.length - 1)
  })

  it('bounds the wait even when attestation ignores cancellation', async () => {
    const fetchFn = transport(async () => new Promise<Response>(() => {}))
    expect(
      await probeCatalogModels({ database: env.db, settings, fetchFn, confidentialFetch: fetchFn, timeoutMs: 5 }),
    ).toEqual(defaultModels.map(({ model }) => ({ model, reason: 'timeout' })))
  })

  it('bounds concurrency', async () => {
    const active = new Set<Request>()
    const fetchFn = transport(async (request) => {
      active.add(request)
      expect(active.size).toBe(1)
      await Bun.sleep(2)
      active.delete(request)
      return completion()
    })
    expect(
      await probeCatalogModels({ database: env.db, settings, fetchFn, confidentialFetch: fetchFn, concurrency: 1 }),
    ).toEqual([])
  })
})
