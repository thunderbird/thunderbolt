/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as platform from '@/lib/platform'
import * as native from '@/lib/native-fetch'
import { searchOAuthFetch } from './mcp-search-auth'

const previousUrl = window.location.href
beforeEach(() => {
  window.location.href = 'http://localhost:5199/settings/connections'
})
const browserFetch = spyOn(globalThis, 'fetch')
const nativeFetch = spyOn(native, 'nativeFetch')
const isTauri = spyOn(platform, 'isTauri')
afterEach(() => {
  window.location.href = previousUrl
  browserFetch.mockReset()
  nativeFetch.mockReset()
  isTauri.mockReset()
})

afterAll(() => {
  browserFetch.mockRestore()
  nativeFetch.mockRestore()
  isTauri.mockRestore()
})

test('browser discovery, token exchange and MCP calls use same-origin endpoints', async () => {
  isTauri.mockReturnValue(false)
  browserFetch.mockResolvedValue(Response.json({}))
  const send = searchOAuthFetch()
  await send('https://auth.exa.ai/.well-known/oauth-authorization-server')
  expect(browserFetch.mock.calls[0][0]).toBe('/_exa/authorization-server')
  await send('https://auth.exa.ai/api/oauth/token', { method: 'POST', body: 'code=test&code_verifier=test' })
  expect(browserFetch.mock.calls[1][0]).toBe('/_exa/token')
  expect(browserFetch.mock.calls[1][1]).toMatchObject({
    method: 'POST',
    body: 'code=test&code_verifier=test',
    credentials: 'omit',
    redirect: 'error',
  })
  await send('https://mcp.exa.ai/mcp/oauth?tools=web_search_advanced_exa')
  expect(browserFetch.mock.calls[2][0]).toBe('/_exa/mcp?tools=web_search_advanced_exa')
  expect(nativeFetch).not.toHaveBeenCalled()
})

test('preserves a Request body, headers and cancellation while rewriting its destination', async () => {
  isTauri.mockReturnValue(false)
  browserFetch.mockResolvedValue(Response.json({}))
  const controller = new AbortController()
  const input = new Request('https://auth.exa.ai/api/oauth/token', {
    method: 'POST',
    body: 'refresh_token=test',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: controller.signal,
  })
  await searchOAuthFetch()(input)
  const request = browserFetch.mock.calls[0][0] as Request
  expect(new URL(request.url).pathname).toBe('/_exa/token')
  expect(request.method).toBe('POST')
  expect(await request.text()).toBe('refresh_token=test')
  expect(request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
  const signal = browserFetch.mock.calls[0][1]?.signal
  expect(signal?.aborted).toBe(false)
  controller.abort()
  expect(signal?.aborted).toBe(true)
})

test('native requests go directly to Exa and other browser providers keep their original URL', async () => {
  isTauri.mockReturnValue(true)
  nativeFetch.mockResolvedValue(Response.json({}))
  await searchOAuthFetch()('https://auth.exa.ai/api/oauth/token')
  expect(nativeFetch.mock.calls[0][0]).toBe('https://auth.exa.ai/api/oauth/token')
  expect(browserFetch).not.toHaveBeenCalled()
  isTauri.mockReturnValue(false)
  browserFetch.mockResolvedValue(Response.json({}))
  await searchOAuthFetch()('https://mcp.tavily.com/mcp/')
  expect(browserFetch.mock.calls[0][0]).toBe('https://mcp.tavily.com/mcp/')
})

test('combines the operation and per-request cancellation signals', async () => {
  isTauri.mockReturnValue(false)
  browserFetch.mockResolvedValue(Response.json({}))
  for (const which of ['operation', 'request']) {
    const operation = new AbortController()
    const request = new AbortController()
    await searchOAuthFetch(operation.signal)('https://auth.exa.ai/api/oauth/token', { signal: request.signal })
    const combined = browserFetch.mock.lastCall?.[1]?.signal
    ;(which === 'operation' ? operation : request).abort()
    expect(combined?.aborted).toBe(true)
  }
})
