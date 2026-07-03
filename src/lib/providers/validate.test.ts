/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { listProviderModels, validateModelsCapability, validateSearchCapability } from './validate'

/** Build a fetch stub that returns queued responses in call order. */
const stubFetch = (responses: Array<{ status?: number; json?: unknown; text?: string; contentType?: string }>) => {
  let i = 0
  const calls: string[] = []
  const fn = (async (url: string | URL) => {
    calls.push(url.toString())
    const r = responses[i++] ?? { status: 500 }
    const status = r.status ?? 200
    return new Response(r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : ''), {
      status,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fn, calls: () => calls }
}

describe('listProviderModels', () => {
  it('parses the OpenAI-style {data:[{id}]} shape', async () => {
    const { fn } = stubFetch([{ json: { data: [{ id: 'gpt-4o', context_length: 128000 }, { id: 'gpt-4o-mini' }] } }])
    const models = await listProviderModels('openai', { apiKey: 'sk' }, fn)
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(models[0].contextWindow).toBe(128000)
  })

  it('parses the Ollama-native {models:[{name}]} shape', async () => {
    const { fn } = stubFetch([{ json: { models: [{ name: 'llama3' }] } }])
    const models = await listProviderModels('ollama', { baseUrl: 'http://localhost:11434/v1' }, fn)
    expect(models).toEqual([{ id: 'llama3', name: 'llama3' }])
  })

  it('throws with status on a non-ok list response', async () => {
    const { fn } = stubFetch([{ status: 401, text: 'unauthorized' }])
    await expect(listProviderModels('openai', { apiKey: 'bad' }, fn)).rejects.toThrow(/401/)
  })
})

describe('validateModelsCapability', () => {
  it('passes when list + test completion both succeed', async () => {
    const { fn, calls } = stubFetch([{ json: { data: [{ id: 'gpt-4o' }] } }, { json: { choices: [] } }])
    const result = await validateModelsCapability('openai', { apiKey: 'sk' }, fn)
    expect(result).toEqual({ ok: true })
    expect(calls()).toHaveLength(2)
  })

  it('fails with the upstream error when the test completion is rejected', async () => {
    const { fn } = stubFetch([{ json: { data: [{ id: 'gpt-4o' }] } }, { status: 402, text: 'insufficient credit' }])
    const result = await validateModelsCapability('openai', { apiKey: 'sk' }, fn)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/402.*insufficient credit/)
    }
  })

  it('fails when no models are returned', async () => {
    const { fn } = stubFetch([{ json: { data: [] } }])
    const result = await validateModelsCapability('openai', { apiKey: 'sk' }, fn)
    expect(result.ok).toBe(false)
  })
})

describe('validateSearchCapability', () => {
  it('passes on a successful search', async () => {
    const { fn } = stubFetch([{ json: { results: [{ title: 'x' }] } }])
    expect(await validateSearchCapability('exa', { apiKey: 'k' }, fn)).toEqual({ ok: true })
  })

  it('rejects a SearXNG instance that returns HTML instead of JSON', async () => {
    const { fn } = stubFetch([{ text: '<html>...</html>', contentType: 'text/html' }])
    const result = await validateSearchCapability('searxng', { baseUrl: 'https://searx.example.com' }, fn)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/JSON/)
    }
  })

  it('accepts a SearXNG instance that returns JSON', async () => {
    const { fn } = stubFetch([{ json: { results: [] }, contentType: 'application/json' }])
    expect(await validateSearchCapability('searxng', { baseUrl: 'https://searx.example.com' }, fn)).toEqual({
      ok: true,
    })
  })
})
