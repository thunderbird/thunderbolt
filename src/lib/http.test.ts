/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createAuthenticatedClient, createClient, HttpError } from './http'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const mockFetch = (response: Partial<Response> = {}) => {
  const ok = response.ok ?? true
  const status = response.status ?? 200
  return mock<FetchFn>(() =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true }), {
        status,
        headers: { 'Content-Type': 'application/json' },
        ...(!ok && { status }),
      }),
    ),
  )
}

describe('createClient', () => {
  it('makes GET requests', async () => {
    const fetch = mockFetch()
    const client = createClient({ fetch })
    await client.get('https://example.com/api')
    expect(fetch).toHaveBeenCalledTimes(1)
    const req = fetch.mock.calls[0][0] as Request
    expect(req.method).toBe('GET')
    expect(req.url).toBe('https://example.com/api')
  })

  it('makes POST requests with JSON body', async () => {
    const fetch = mockFetch()
    const client = createClient({ fetch })
    await client.post('https://example.com/api', { json: { name: 'test' } })
    const req = fetch.mock.calls[0][0] as Request
    expect(req.method).toBe('POST')
    expect(req.headers.get('Content-Type')).toBe('application/json')
    expect(await req.json()).toEqual({ name: 'test' })
  })

  it('appends search params', async () => {
    const fetch = mockFetch()
    const client = createClient({ fetch })
    await client.get('https://example.com/api', { searchParams: { q: 'hello', page: 1 } })
    const req = fetch.mock.calls[0][0] as Request
    expect(req.url).toBe('https://example.com/api?q=hello&page=1')
  })

  it('resolves URLs with prefixUrl', async () => {
    const fetch = mockFetch()
    const client = createClient({ prefixUrl: 'https://api.example.com', fetch })
    await client.get('users')
    const req = fetch.mock.calls[0][0] as Request
    expect(req.url).toBe('https://api.example.com/users')
  })

  it('does not prefix absolute URLs', async () => {
    const fetch = mockFetch()
    const client = createClient({ prefixUrl: 'https://api.example.com', fetch })
    await client.get('https://other.com/resource')
    const req = fetch.mock.calls[0][0] as Request
    expect(req.url).toBe('https://other.com/resource')
  })

  it('throws HttpError on non-2xx response', async () => {
    const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Not Found', { status: 404 })))
    const client = createClient({ fetch })
    await expect(client.get('https://example.com/missing')).rejects.toBeInstanceOf(HttpError)
  })

  it('passes custom headers through', async () => {
    const fetch = mockFetch()
    const client = createClient({ fetch })
    await client.get('https://example.com/api', {
      headers: { 'X-Custom': 'value' },
    })
    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('X-Custom')).toBe('value')
  })

  it('runs beforeRequest hooks', async () => {
    const fetch = mockFetch()
    const hook = mock<(req: Request) => void>(() => {})
    const client = createClient({ fetch, hooks: { beforeRequest: [hook] } })
    await client.get('https://example.com/api')
    expect(hook).toHaveBeenCalledTimes(1)
  })
})

describe('createAuthenticatedClient', () => {
  it('sets Authorization header when token is available', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })
    await client.get('data')
    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBe('Bearer app-token')
  })

  it('does not set Authorization header when token is null', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => null, { fetch })
    await client.get('data')
    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBeNull()
  })

  it('preserves caller-provided Authorization header (OAuth tokens)', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

    // Simulate what Google/Microsoft tools do: pass their own OAuth token
    await client.get('https://www.googleapis.com/gmail/v1/users/me/messages', {
      headers: { Authorization: 'Bearer google-oauth-token' },
    })

    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBe('Bearer google-oauth-token')
  })

  it('preserves caller-provided Authorization on POST requests', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

    await client.post('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
      json: { raw: 'base64data' },
      headers: { Authorization: 'Bearer google-oauth-token' },
    })

    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBe('Bearer google-oauth-token')
  })

  it('still sets app token when no Authorization header is provided', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

    // Normal app API call with other headers but no Authorization
    await client.get('data', { headers: { 'X-Device-ID': 'device-123' } })

    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBe('Bearer app-token')
    expect(req.headers.get('X-Device-ID')).toBe('device-123')
  })
})
