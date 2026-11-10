/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, mock } from 'bun:test'
import { AttestationError } from 'tinfoil'
import { createTinfoilToolCaller } from './transport'

it('evicts only the failed search generation when a replacement is already active', async () => {
  const pending = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  const old = {
    baseURL: 'https://websearch.tinfoil.sh/',
    fetch: async () => {
      started.resolve()
      return pending.promise
    },
  }
  const replacement = { ...old }
  const active: { client: object | null } = { client: old }
  const evict = mock((client: object) => {
    if (active.client === client) {
      active.client = null
    }
  })
  const caller = createTinfoilToolCaller(async () => 'token', { acquire: async () => old, evict })
  const request = caller('search', { query: 'query' }).catch((error: unknown) => error)
  await started.promise
  active.client = replacement
  pending.reject(new AttestationError('old key rejected'))
  expect(await request).toBeInstanceOf(AttestationError)
  expect(evict).toHaveBeenCalledWith(old)
  expect(active.client).toBe(replacement)
})

it('uses authenticated attested MCP requests, supports SSE, and closes each session', async () => {
  const requests: Array<{ url: string; init?: RequestInit; method?: string }> = []
  const secure = {
    baseURL: 'https://websearch.tinfoil.sh/',
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
  const caller = createTinfoilToolCaller(getKey, { acquire: async () => secure, evict: mock(() => {}) })
  expect(await caller('search', { query: 'test' })).toMatchObject({
    content: [{ type: 'text', text: '{"results":[]}' }],
  })
  expect(requests.some((request) => request.method === 'tools/call')).toBe(true)
  expect(requests.some((request) => request.init?.method === 'GET')).toBe(false)
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
    evict: mock(() => {}),
  })
  await expect(caller('search', { query: 'test' })).rejects.toThrow('attestation failed')
  expect(getKey).not.toHaveBeenCalled()
})
