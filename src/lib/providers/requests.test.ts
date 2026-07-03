/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { buildChatCompletionRequest, buildModelsListRequest, buildSearchRequest } from './requests'

describe('buildModelsListRequest', () => {
  it('uses the catalog base URL and bearer auth for OpenRouter', () => {
    const { url, init } = buildModelsListRequest('openrouter', { apiKey: 'sk-or' })
    expect(url).toBe('https://openrouter.ai/api/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or')
  })

  it('uses x-api-key + anthropic-version for Anthropic', () => {
    const { url, init } = buildModelsListRequest('anthropic', { apiKey: 'sk-ant' })
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect(headers['x-api-key']).toBe('sk-ant')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('honors a base URL override for url-type providers and trims trailing slash', () => {
    const { url } = buildModelsListRequest('ollama', { baseUrl: 'http://localhost:11434/v1/' })
    expect(url).toBe('http://localhost:11434/v1/models')
  })

  it('throws for a url provider with no base URL', () => {
    expect(() => buildModelsListRequest('custom', {})).toThrow(/requires a base URL/)
  })
})

describe('buildChatCompletionRequest', () => {
  it('builds a 1-token OpenAI-shaped completion by default', () => {
    const { url, init } = buildChatCompletionRequest('openai', { apiKey: 'sk' }, { model: 'gpt-4o', prompt: 'Hi' })
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ model: 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
  })

  it('targets the Anthropic messages endpoint', () => {
    const { url } = buildChatCompletionRequest('anthropic', { apiKey: 'sk' }, { model: 'claude', prompt: 'Hi' })
    expect(url).toBe('https://api.anthropic.com/v1/messages')
  })
})

describe('buildSearchRequest', () => {
  it('POSTs a JSON body for Exa with x-api-key', () => {
    const { url, init } = buildSearchRequest('exa', { apiKey: 'exa-key' }, { query: 'cats', numResults: 3 })
    expect(url).toBe('https://api.exa.ai/search')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('exa-key')
    expect(JSON.parse(init.body as string)).toEqual({ query: 'cats', numResults: 3 })
  })

  it('GETs Brave with subscription token header and count', () => {
    const { url, init } = buildSearchRequest('brave', { apiKey: 'brave-key' }, { query: 'cats', numResults: 4 })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(u.searchParams.get('q')).toBe('cats')
    expect(u.searchParams.get('count')).toBe('4')
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-key')
  })

  it('puts the SerpAPI key in the query string with engine=google', () => {
    const { url } = buildSearchRequest('serpapi', { apiKey: 'serp-key' }, { query: 'cats' })
    const u = new URL(url)
    expect(u.searchParams.get('api_key')).toBe('serp-key')
    expect(u.searchParams.get('engine')).toBe('google')
    expect(u.searchParams.get('q')).toBe('cats')
  })

  it('requests JSON format from a user SearXNG base URL', () => {
    const { url } = buildSearchRequest('searxng', { baseUrl: 'https://searx.example.com' }, { query: 'cats' })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://searx.example.com/search')
    expect(u.searchParams.get('format')).toBe('json')
  })

  it('hits the keyless DuckDuckGo HTML endpoint', () => {
    const { url, init } = buildSearchRequest('duckduckgo', {}, { query: 'cats' })
    expect(new URL(url).origin + new URL(url).pathname).toBe('https://html.duckduckgo.com/html/')
    expect(new URL(url).searchParams.get('q')).toBe('cats')
    expect(init.headers).toEqual({})
  })
})
