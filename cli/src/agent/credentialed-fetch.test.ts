/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, spyOn, test } from 'bun:test'
import { createCredentialedFetch, withCredentialedFetch } from './credentialed-fetch.ts'

type ObservedRequest = { request?: Request; init?: RequestInit }

describe('createCredentialedFetch', () => {
  test.each([301, 302, 307] as const)(
    'blocks a %i cross-origin redirect before Bearer or x-api-key reaches the target',
    async (status) => {
      const targetHeaders: Headers[] = []
      const target = Bun.serve({
        port: 0,
        fetch: (request) => {
          targetHeaders.push(request.headers)
          return Response.json({ ok: true })
        },
      })
      const sourceHeaders: Headers[] = []
      const source = Bun.serve({
        port: 0,
        fetch: (request) => {
          sourceHeaders.push(request.headers)
          return Response.redirect(`http://127.0.0.1:${target.port}/stolen`, status)
        },
      })

      try {
        const request = createCredentialedFetch(`http://127.0.0.1:${source.port}/v1`)

        await expect(
          request(`http://127.0.0.1:${source.port}/v1/models`, {
            headers: {
              authorization: 'Bearer secret',
              'x-api-key': 'key-secret',
              'x-goog-api-key': 'google-secret',
            },
          }),
        ).rejects.toBeDefined()

        expect(sourceHeaders).toHaveLength(1)
        expect(sourceHeaders[0]?.get('authorization')).toBe('Bearer secret')
        expect(sourceHeaders[0]?.get('x-api-key')).toBe('key-secret')
        expect(sourceHeaders[0]?.get('x-goog-api-key')).toBe('google-secret')
        expect(targetHeaders).toEqual([])
      } finally {
        source.stop(true)
        target.stop(true)
      }
    },
  )

  test('rejects remote cleartext and cross-origin requests before dispatch', async () => {
    let requests = 0
    const fetchFn = async (): Promise<Response> => {
      requests += 1
      return Response.json({ ok: true })
    }

    expect(() => createCredentialedFetch('http://provider.example/v1', fetchFn)).toThrow('https')
    const request = createCredentialedFetch('https://provider.example/v1', fetchFn)
    await expect(request('https://other.example/v1/models')).rejects.toThrow('origin')
    expect(requests).toBe(0)
  })

  test('keeps concurrent async credential contexts isolated by origin and header family', async () => {
    const calls: { readonly owner: string; readonly url: string; readonly headers: Headers }[] = []
    const fetchA = createCredentialedFetch('https://a.example/v1', async (input, init) => {
      calls.push({ owner: 'a', url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ owner: 'a' })
    })
    const fetchB = createCredentialedFetch('https://b.example/v1', async (input, init) => {
      calls.push({ owner: 'b', url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ owner: 'b' })
    })

    await Promise.all([
      withCredentialedFetch(fetchA, async () => {
        await Promise.resolve()
        await globalThis.fetch('https://a.example/v1/messages', {
          headers: { 'x-api-key': 'anthropic-key' },
        })
      }),
      withCredentialedFetch(fetchB, async () => {
        await Promise.resolve()
        await globalThis.fetch('https://b.example/v1/models', {
          headers: { authorization: 'Bearer openai-key' },
        })
      }),
    ])

    expect(calls.map(({ owner, url }) => ({ owner, url }))).toEqual([
      { owner: 'a', url: 'https://a.example/v1/messages' },
      { owner: 'b', url: 'https://b.example/v1/models' },
    ])
    expect(calls[0]?.headers.get('x-api-key')).toBe('anthropic-key')
    expect(calls[0]?.headers.has('authorization')).toBe(false)
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer openai-key')
    expect(calls[1]?.headers.has('x-api-key')).toBe(false)
  })

  test('blocks same-origin redirects without dispatching the redirected request', async () => {
    let targetRequests = 0
    const server = Bun.serve({
      port: 0,
      fetch: (request): Response => {
        if (new URL(request.url).pathname === '/target') {
          targetRequests += 1
          return Response.json({ ok: true })
        }
        return new Response(null, { status: 302, headers: { location: '/target' } })
      },
    })
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`
      await expect(
        createCredentialedFetch(baseUrl)(`${baseUrl}/start`, {
          headers: { authorization: 'Bearer secret' },
        }),
      ).rejects.toBeDefined()
      expect(targetRequests).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test('preserves a Request method, body, headers, and abort signal while forcing redirect error', async () => {
    const controller = new AbortController()
    const observed: ObservedRequest = {}
    const request = new Request('https://provider.example/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'secret' },
      body: 'payload',
      signal: controller.signal,
    })
    const wrapped = createCredentialedFetch('https://provider.example/v1', async (input, init) => {
      observed.request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      observed.init = init
      return Response.json({ ok: true })
    })

    await wrapped(request)

    expect(observed.request?.method).toBe('POST')
    expect(observed.request?.headers.get('x-api-key')).toBe('secret')
    expect(await observed.request?.text()).toBe('payload')
    expect(observed.request?.signal.aborted).toBe(false)
    expect(observed.init?.redirect).toBe('error')
  })

  test('does not fabricate response evidence when the network rejects', async () => {
    let observations = 0
    const wrapped = createCredentialedFetch(
      'https://provider.example/v1',
      async () => {
        throw new TypeError('offline')
      },
      () => {
        observations += 1
      },
    )

    await expect(wrapped('https://provider.example/v1/models')).rejects.toThrow('offline')
    expect(observations).toBe(0)
  })

  test('preserves a paid 2xx response when status bookkeeping fails', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    let requests = 0
    try {
      const wrapped = createCredentialedFetch(
        'https://provider.example/v1',
        async () => {
          requests += 1
          return Response.json({ answer: 'preserved' })
        },
        async () => {
          throw new Error('disk full')
        },
      )

      const response = await wrapped('https://provider.example/v1/messages')

      expect(await response.json()).toEqual({ answer: 'preserved' })
      expect(requests).toBe(1)
      expect(errorLog).toHaveBeenCalledWith('Credential response observer failed.', expect.any(Error))
    } finally {
      errorLog.mockRestore()
    }
  })
})
