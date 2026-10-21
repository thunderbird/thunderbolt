/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, mock, spyOn } from 'bun:test'
import { nativeFetch } from './native-fetch'

it.each(
  [
    'http://api.example.com:8080/v1/messages?q=one',
    'http://[2002:c000:0204::1]/',
    'http://[2001:0::1]/',
    'http://192.88.99.1/',
  ].flatMap((url) => (['string', 'URL', 'Request'] as const).map((kind) => [kind, url] as const)),
)('upgrades public HTTP %s input %s with method, headers and body intact', async (kind, url) => {
  const init = { method: 'POST', headers: { 'x-api-key': 'provider-key' }, body: 'payload' }
  const input = kind === 'string' ? url : kind === 'URL' ? new URL(url) : new Request(url, init)
  const sent: Request[] = []
  await nativeFetch(input, kind === 'Request' ? undefined : init, async (input, options) => {
    sent.push(new Request(input, options))
    return new Response(null, { status: 204 })
  })
  expect(sent[0].url).toBe(new URL(url.replace('http:', 'https:')).href)
  expect(sent[0].method).toBe('POST')
  expect(sent[0].headers.get('x-api-key')).toBe('provider-key')
  expect(await sent[0].text()).toBe('payload')
})

it.each([
  'localhost',
  'api.localhost',
  '127.0.0.2',
  '[::1]',
  '10.1.2.3',
  '172.16.0.2',
  '192.168.1.2',
  '[fd00::1]',
  '[::ffff:192.168.1.2]',
  '[::192.168.1.10]',
  '[fe80::1]',
  '169.254.1.2',
  '100.64.0.1',
  '0.0.0.0',
  '[::]',
  'host.docker.internal',
  'server.local',
  'SERVER.LOCAL.',
  'api.localhost.',
])('keeps local/private HTTP target %s on plain HTTP', async (host) => {
  const url = new URL(`http://${host}:8080/v1`).href
  const sent: Request[] = []
  await nativeFetch(url, undefined, async (input, options) => {
    sent.push(new Request(input, options))
    return new Response(null, { status: 204 })
  })
  expect(sent[0].url).toBe(url)
})

it('keeps Request overrides when upgrading public HTTP', async () => {
  const request = new Request('http://api.example.com/v1', { method: 'POST', body: 'original' })
  const sent: Request[] = []
  await nativeFetch(
    request,
    { method: 'PUT', body: 'override', headers: { 'x-api-key': 'override-key' } },
    async (input, init) => {
      // Happy DOM ignores body overrides on Request inputs; read the supplied override against its URL.
      sent.push(new Request(input instanceof Request ? input.url : input, init))
      return new Response(null, { status: 204 })
    },
  )
  expect(sent[0].url).toBe('https://api.example.com/v1')
  expect(sent[0].method).toBe('PUT')
  expect(sent[0].headers.get('x-api-key')).toBe('override-key')
  expect(await sent[0].text()).toBe('override')
})

it.each(
  (['string', 'URL', 'Request', 'Request with init'] as const).flatMap((kind) =>
    (['GET', 'HEAD'] as const).flatMap((method) =>
      [301, 302, 303, 307, 308].map((status) => [kind, method, status] as const),
    ),
  ),
)('follows same-origin redirects for %s %s with status %s', async (kind, method, status) => {
  const url = 'https://provider.example/v1/models'
  const init: RequestInit = {
    method,
    headers: { 'x-api-key': 'provider-key' },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  }
  const input =
    kind === 'string'
      ? url
      : kind === 'URL'
        ? new URL(url)
        : new Request(url, kind === 'Request' ? init : { method: 'POST', headers: { 'x-api-key': 'old-key' } })
  const sent: Request[] = []
  const response = await nativeFetch(input, kind === 'Request' ? undefined : init, async (input, options) => {
    expect(options?.maxRedirections).toBe(0)
    const request = new Request(input, options)
    sent.push(request)
    const response =
      sent.length === 1
        ? new Response(null, { status, headers: { location: './models/' } })
        : new Response(method === 'GET' ? 'catalog' : null)
    Object.defineProperty(response, 'url', { value: request.url })
    return response
  })
  expect(sent.map((request) => request.url)).toEqual([url, 'https://provider.example/v1/models/'])
  for (const request of sent) {
    expect(request.method).toBe(method)
    expect(request.headers.get('x-api-key')).toBe('provider-key')
    expect(request.credentials).toBe('omit')
    expect(request.referrerPolicy).toBe('no-referrer')
  }
  expect(response.url).toBe('https://provider.example/v1/models/')
  expect(await response.text()).toBe(method === 'GET' ? 'catalog' : '')
})

it('follows GET but returns POST 307 without replaying its body', async () => {
  for (const method of ['GET', 'POST']) {
    const sent: Request[] = []
    const response = await nativeFetch(
      'https://provider.example/start',
      { method, body: method === 'POST' ? 'payload' : undefined },
      async (input, options) => {
        const request = new Request(input, options)
        sent.push(request)
        return request.url.endsWith('/start')
          ? new Response('redirect', { status: 307, headers: { location: '/final' } })
          : new Response(null, { status: 204 })
      },
    )
    expect(sent).toHaveLength(method === 'GET' ? 2 : 1)
    expect(response.status).toBe(method === 'GET' ? 204 : 307)
    expect(await response.text()).toBe(method === 'GET' ? '' : 'redirect')
    if (method === 'POST') {
      expect(await sent[0].text()).toBe('payload')
    }
  }
})

it.each([
  ['https://provider.example/start', 'https://other.example/final'],
  ['https://provider.example/start', 'https://provider.example:444/final'],
  ['http://localhost:8080/start', 'https://localhost:8080/final'],
  ['https://provider.example./start', 'https://provider.example/final'],
  ['https://provider.example/start', 'http://[invalid'],
  ['https://provider.example/start', undefined],
] as const)('stops a redirect chain from %s at Location %s', async (url, location) => {
  const sent: Request[] = []
  const response = await nativeFetch(url, { headers: { 'x-api-key': 'provider-key' } }, async (input, options) => {
    const request = new Request(input, options)
    sent.push(request)
    return sent.length === 1
      ? new Response(null, { status: 307, headers: { location: '/next' } })
      : new Response('raw redirect', { status: 307, headers: location ? { location } : undefined })
  })
  expect(sent).toHaveLength(2)
  expect(sent[1].url).toBe(new URL('/next', url).href)
  expect(sent[1].headers.get('x-api-key')).toBe('provider-key')
  expect(response.status).toBe(307)
  expect(await response.text()).toBe('raw redirect')
})

it('follows an explicit default port on the same origin', async () => {
  const sent: Request[] = []
  const response = await nativeFetch('https://provider.example/start', undefined, async (input, options) => {
    sent.push(new Request(input, options))
    return sent.length === 1
      ? new Response(null, { status: 307, headers: { location: 'https://provider.example:443/final' } })
      : new Response(null, { status: 204 })
  })
  expect(sent.map((request) => request.url)).toEqual([
    'https://provider.example/start',
    'https://provider.example/final',
  ])
  expect(response.status).toBe(204)
})

it.each([5, 6])('allows five follows and fails on redirect number %s without a seventh call', async (redirects) => {
  const caller = new AbortController()
  const removed = spyOn(caller.signal, 'removeEventListener')
  const cancel = mock(() => {})
  const sent: Request[] = []
  try {
    const result = nativeFetch('https://provider.example/start', { signal: caller.signal }, async (input, options) => {
      sent.push(new Request(input, options))
      return sent.length <= redirects
        ? new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: `/${sent.length}` } })
        : new Response(null, { status: 204 })
    })
    if (redirects === 6) {
      await expect(result).rejects.toMatchObject({ name: 'TypeError', message: 'Failed to fetch' })
    } else {
      expect((await result).status).toBe(204)
    }
    expect(sent).toHaveLength(6)
    expect(cancel).toHaveBeenCalledTimes(redirects)
    expect(removed).toHaveBeenCalledTimes(1)
  } finally {
    removed.mockRestore()
  }
})

it('cancels the discarded redirect body before sending the next hop', async () => {
  const cancel = mock(() => {})
  const sent: Request[] = []
  const response = await nativeFetch('https://provider.example/start', undefined, async (input, options) => {
    sent.push(new Request(input, options))
    if (sent.length === 1) {
      return new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: '/final' } })
    }
    expect(cancel).toHaveBeenCalledTimes(1)
    return new Response('done')
  })
  expect(sent).toHaveLength(2)
  expect(await response.text()).toBe('done')
})

it('stops and detaches the relay when the caller aborts between hops', async () => {
  const caller = new AbortController()
  const added = spyOn(caller.signal, 'addEventListener')
  const removed = spyOn(caller.signal, 'removeEventListener')
  const reason = new Error('session closed between hops')
  const cancel = mock(() => caller.abort(reason))
  const sent: Request[] = []
  try {
    await expect(
      nativeFetch('https://provider.example/start', { signal: caller.signal }, async (input, options) => {
        sent.push(new Request(input, options))
        return new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: '/final' } })
      }),
    ).rejects.toBe(reason)
    expect(sent).toHaveLength(1)
    expect(sent[0].signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(added).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0][1])
  } finally {
    added.mockRestore()
    removed.mockRestore()
  }
})
