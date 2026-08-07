/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTestSettings } from '@/test-utils/settings'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  clearGatewayModelCache,
  ensureGatewayModels,
  getGatewayModelSpecs,
  getGatewaySharedModels,
  isGatewayModel,
  parseGatewayModelSpecs,
} from './gateway-models'

const configured = (models = '') =>
  createTestSettings({
    thunderboltInferenceUrl: 'https://gateway.example.com/v1',
    thunderboltInferenceApiKey: 'key',
    thunderboltInferenceModels: models,
  })

/** Stub of an OpenAI-compatible `GET /models` response. */
const modelsResponse = (ids: string[]) =>
  mock(async () => new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }), { status: 200 }))

beforeEach(() => {
  clearGatewayModelCache()
})

describe('parseGatewayModelSpecs', () => {
  it('parses bare ids and defaults the label to the id', () => {
    expect(parseGatewayModelSpecs('a,b')).toEqual([
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
    ])
  })

  it('parses id=Label, keeping spaces inside the label', () => {
    expect(parseGatewayModelSpecs('llama-3.3-70b=Llama 3.3 70B')).toEqual([
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' },
    ])
  })

  it('trims whitespace and drops empty entries', () => {
    expect(parseGatewayModelSpecs('  a  , ,, b ')).toEqual([
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
    ])
  })

  it('skips malformed entries rather than throwing, so a typo cannot stop boot', () => {
    expect(parseGatewayModelSpecs('=Orphan Label,ok')).toEqual([{ id: 'ok', label: 'ok' }])
  })

  it('keeps the first of a duplicated id', () => {
    expect(parseGatewayModelSpecs('a=First,a=Second')).toEqual([{ id: 'a', label: 'First' }])
  })

  it('returns nothing for an empty string', () => {
    expect(parseGatewayModelSpecs('')).toEqual([])
  })
})

describe('ensureGatewayModels', () => {
  it('discovers whatever the gateway advertises, with no list configured', async () => {
    const fetchFn = modelsResponse(['llama-3.3-70b', 'kimi'])
    const specs = await ensureGatewayModels(configured(), { fetchFn: fetchFn as never })

    expect(specs).toEqual([
      { id: 'llama-3.3-70b', label: 'llama-3.3-70b' },
      { id: 'kimi', label: 'kimi' },
    ])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('requests /models on the configured base URL with the api key', async () => {
    const fetchFn = modelsResponse(['a'])
    await ensureGatewayModels(configured(), { fetchFn: fetchFn as never })

    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('https://gateway.example.com/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key')
  })

  it('treats a configured list as an allowlist over discovery', async () => {
    const fetchFn = modelsResponse(['keep', 'drop'])
    const specs = await ensureGatewayModels(configured('keep'), { fetchFn: fetchFn as never })

    expect(specs).toEqual([{ id: 'keep', label: 'keep' }])
  })

  it('uses the configured entry as a display label', async () => {
    const fetchFn = modelsResponse(['kimi'])
    const specs = await ensureGatewayModels(configured('kimi=Kimi K2'), { fetchFn: fetchFn as never })

    expect(specs).toEqual([{ id: 'kimi', label: 'Kimi K2' }])
  })

  it('ignores allowlist entries the gateway does not serve', async () => {
    const fetchFn = modelsResponse(['real'])
    const specs = await ensureGatewayModels(configured('real,typo'), { fetchFn: fetchFn as never })

    expect(specs.map((s) => s.id)).toEqual(['real'])
  })

  it('is empty and makes no request when no gateway URL is set', async () => {
    const fetchFn = modelsResponse(['a'])
    expect(await ensureGatewayModels(createTestSettings(), { fetchFn: fetchFn as never })).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  // A gateway outage must not take the app's built-in models down with it.
  it('returns empty on a non-OK response instead of throwing', async () => {
    const fetchFn = mock(async () => new Response('nope', { status: 503 }))
    expect(await ensureGatewayModels(configured(), { fetchFn: fetchFn as never })).toEqual([])
  })

  it('returns empty when the request throws instead of propagating', async () => {
    const fetchFn = mock(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await ensureGatewayModels(configured(), { fetchFn: fetchFn as never })).toEqual([])
  })

  it('skips malformed entries in the payload', async () => {
    const fetchFn = mock(
      async () => new Response(JSON.stringify({ data: [{ id: 'ok' }, { id: 42 }, {}, { id: '' }] }), { status: 200 }),
    )
    const specs = await ensureGatewayModels(configured(), { fetchFn: fetchFn as never })
    expect(specs).toEqual([{ id: 'ok', label: 'ok' }])
  })

  it('serves a warm cache without refetching', async () => {
    const fetchFn = modelsResponse(['a'])
    const settings = configured()
    await ensureGatewayModels(settings, { fetchFn: fetchFn as never, nowFn: () => 1_000 })
    await ensureGatewayModels(settings, { fetchFn: fetchFn as never, nowFn: () => 1_500 })

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('refetches once the cache goes stale', async () => {
    const fetchFn = modelsResponse(['a'])
    const settings = configured()
    await ensureGatewayModels(settings, { fetchFn: fetchFn as never, nowFn: () => 0 })
    await ensureGatewayModels(settings, { fetchFn: fetchFn as never, nowFn: () => 10 * 60 * 1000 })

    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('refetches when the allowlist changes', async () => {
    const fetchFn = modelsResponse(['a', 'b'])
    await ensureGatewayModels(configured(), { fetchFn: fetchFn as never, nowFn: () => 0 })
    const specs = await ensureGatewayModels(configured('b'), { fetchFn: fetchFn as never, nowFn: () => 0 })

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(specs.map((s) => s.id)).toEqual(['b'])
  })
})

describe('getGatewayModelSpecs', () => {
  it('is empty before any discovery has run', () => {
    expect(getGatewayModelSpecs(configured())).toEqual([])
  })

  it('reads the last discovery without touching the network', async () => {
    await ensureGatewayModels(configured(), { fetchFn: modelsResponse(['a']) as never })
    expect(getGatewayModelSpecs(configured()).map((s) => s.id)).toEqual(['a'])
  })

  it('is empty when the gateway URL no longer matches the cached one', async () => {
    await ensureGatewayModels(configured(), { fetchFn: modelsResponse(['a']) as never })
    const moved = createTestSettings({ thunderboltInferenceUrl: 'https://other.example.com/v1' })
    expect(getGatewayModelSpecs(moved)).toEqual([])
  })
})

describe('isGatewayModel', () => {
  it('matches only exact discovered ids', async () => {
    const settings = configured()
    await ensureGatewayModels(settings, { fetchFn: modelsResponse(['llama-3.3-70b']) as never })

    expect(isGatewayModel('llama-3.3-70b', settings)).toBe(true)
    expect(isGatewayModel('llama', settings)).toBe(false)
    expect(isGatewayModel('opus-4.8', settings)).toBe(false)
  })

  it('is false when the gateway is unconfigured', () => {
    expect(isGatewayModel('anything', createTestSettings())).toBe(false)
  })
})

describe('getGatewaySharedModels', () => {
  const discover = async (models = '', ids = ['llama-3.3-70b']) => {
    const settings = configured(models)
    await ensureGatewayModels(settings, { fetchFn: modelsResponse(ids) as never })
    return getGatewaySharedModels(settings)
  }

  it('publishes rows the frontend routes back through this backend', async () => {
    const [model] = await discover('llama-3.3-70b=Llama 3.3 70B')

    // provider 'thunderbolt' + url null is the "call the backend" contract, which
    // is what keeps the gateway key server-side.
    expect(model.provider).toBe('thunderbolt')
    expect(model.url).toBeNull()
    expect(model.model).toBe('llama-3.3-70b')
    expect(model.name).toBe('Llama 3.3 70B')
    expect(model.enabled).toBe(1)
  })

  it('advertises conservative capabilities for an uninspectable endpoint', async () => {
    const [model] = await discover()

    // vendor null means images are stripped rather than guessed, and parallel
    // tool calls stay off so an unsupporting model does not error on every call.
    expect(model.vendor).toBeNull()
    expect(model.contextWindow).toBeNull()
    expect(model.supportsParallelToolCalls).toBe(0)
    expect(model.isConfidential).toBe(0)
  })

  it('derives a stable RFC 4122 v5 id from the model id', async () => {
    const first = (await discover('', ['some-model']))[0].id
    const second = (await discover('some-model=Renamed', ['some-model']))[0].id

    // Stable across restarts and independent of the label, because the id lands
    // in user databases as a row primary key.
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('gives different models different ids', async () => {
    const ids = (await discover('', ['a', 'b'])).map((model) => model.id)
    expect(new Set(ids).size).toBe(2)
  })
})
