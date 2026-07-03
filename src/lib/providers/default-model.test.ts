/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { selectDefaultModel } from './default-model'

/** Queue of responses; models-list first, then per-test-completion calls. */
const stubFetch = (handler: (url: string, body: unknown) => { status?: number; json?: unknown }) => {
  const calls: string[] = []
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push(url.toString())
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    const r = handler(url.toString(), body)
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : '', { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return { fn, calls: () => calls }
}

describe('selectDefaultModel', () => {
  it('returns the first preferred model whose test passes', async () => {
    const { fn } = stubFetch((url, body) => {
      if (url.endsWith('/models')) {
        return { json: { data: [{ id: 'openai/gpt-4o' }, { id: 'anthropic/claude-3.5-sonnet' }] } }
      }
      // First preferred is anthropic/claude-3.5-sonnet — make it pass.
      const model = (body as { model: string }).model
      return { status: model === 'anthropic/claude-3.5-sonnet' ? 200 : 500 }
    })
    const result = await selectDefaultModel('openrouter', { apiKey: 'k' }, fn)
    expect(result?.id).toBe('anthropic/claude-3.5-sonnet')
  })

  it('falls back to the first listed model when no preferred model passes', async () => {
    const { fn } = stubFetch((url) => {
      if (url.endsWith('/models')) {
        return { json: { data: [{ id: 'some/model-x' }, { id: 'some/model-y' }] } }
      }
      return { status: 500 } // every completion fails
    })
    const result = await selectDefaultModel('openrouter', { apiKey: 'k' }, fn)
    expect(result?.id).toBe('some/model-x')
  })

  it('returns the first listed model for providers with no curated list (ollama)', async () => {
    const { fn } = stubFetch((url) => {
      if (url.endsWith('/models')) {
        return { json: { models: [{ name: 'llama3' }, { name: 'mistral' }] } }
      }
      return { status: 200 }
    })
    const result = await selectDefaultModel('ollama', { baseUrl: 'http://localhost:11434/v1' }, fn)
    expect(result?.id).toBe('llama3')
  })

  it('returns null when the provider exposes no models', async () => {
    const { fn } = stubFetch(() => ({ json: { data: [] } }))
    expect(await selectDefaultModel('openai', { apiKey: 'k' }, fn)).toBeNull()
  })
})
