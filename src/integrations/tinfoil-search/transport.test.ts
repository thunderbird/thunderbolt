/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, mock } from 'bun:test'
import { createTinfoilToolCaller } from './transport'

it('uses authenticated attested MCP requests, supports SSE, and closes each session', async () => {
  const requests: Array<{ url: string; init?: RequestInit; method?: string }> = []
  const secure = {
    evict: mock(() => {}),
    getBaseURL: () => 'https://websearch.tinfoil.sh/v1/',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ url: String(input), init, method: body?.method })
      if (init?.method === 'DELETE' || body?.id === undefined) {
        return new Response(null, { status: init?.method === 'GET' ? 405 : 202 })
      }
      if (body.method === 'initialize') {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'search', version: '1' },
            },
          },
          { headers: { 'mcp-session-id': 'test-session' } },
        )
      }
      const data = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"results":[]}' }] } }
      return new Response(`event: message\ndata: ${JSON.stringify(data)}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  }
  const getKey = mock(async () => 'rotated-token')
  const caller = createTinfoilToolCaller(getKey, { acquire: async () => secure })
  expect(await caller('search', { query: 'test' })).toMatchObject({
    content: [{ type: 'text', text: '{"results":[]}' }],
  })
  expect(requests.some((request) => request.method === 'tools/call')).toBe(true)
  // The SDK closes local transport resources; no persistent session is retained.
  for (const request of requests) {
    expect(request.url).toBe('https://websearch.tinfoil.sh/mcp')
    const headers = new Headers(request.init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer rotated-token')
    expect(headers.get('X-Tinfoil-Tool-PII-Check')).toBe('true')
    expect(headers.get('X-Tinfoil-Tool-Injection-Check')).toBe('true')
    expect(request.init?.credentials).toBe('omit')
  }
  expect(getKey.mock.calls.length).toBe(requests.length)
})

it('never sends credentials when attestation fails', async () => {
  const getKey = mock(async () => 'secret')
  const caller = createTinfoilToolCaller(getKey, {
    acquire: async () => {
      throw new Error('attestation failed')
    },
  })
  await expect(caller('search', { query: 'test' })).rejects.toThrow('attestation failed')
  expect(getKey).not.toHaveBeenCalled()
})

it('retires only the acquired search generation when an old request fails after replacement', async () => {
  const firstResponse = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  let current = 'old'
  const old = {
    getBaseURL: () => 'https://websearch.tinfoil.sh',
    fetch: async () => {
      requested.resolve()
      return firstResponse.promise
    },
    evict: mock(() => {
      if (current === 'old') {
        current = 'none'
      }
    }),
  }
  const caller = createTinfoilToolCaller(async () => 'key', { acquire: async () => old })
  const failed = caller('search', { query: 'old request' })
  void failed.catch(() => {})
  await requested.promise
  current = 'replacement'
  firstResponse.reject(Object.assign(new Error('key rotated'), { name: 'KeyConfigMismatchError' }))
  await expect(failed).rejects.toThrow('key rotated')
  expect(old.evict).toHaveBeenCalledTimes(1)
  expect(current).toBe('replacement')
})
