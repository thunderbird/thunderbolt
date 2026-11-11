/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, mock } from 'bun:test'
import { Identity, PROTOCOL } from 'ehbp'
import { createClient } from '@/lib/http'
import { createAttestedSearchFetch } from './attested-fetch'

it('requires verified attestation before creating the transport', async () => {
  const send = mock(async () => new Response())
  await expect(
    createAttestedSearchFetch({ securityVerified: false, hpkePublicKey: 'untrusted' }, createClient({ fetch: send })),
  ).rejects.toThrow('attestation')
  expect(send).not.toHaveBeenCalled()
})

it('encrypts the request and rejects an unencrypted success response', async () => {
  const identity = await Identity.generate()
  const send = mock(async (input: RequestInfo | URL) => {
    const request = input as Request
    expect(request.url).toBe('https://websearch.tinfoil.sh/mcp')
    expect(request.headers.has(PROTOCOL.ENCAPSULATED_KEY_HEADER)).toBe(true)
    expect(request.credentials).toBe('omit')
    const body = await request.text()
    expect(body).not.toContain('private search query')
    expect(body.length).toBeGreaterThan(0)
    return Response.json({ results: [] })
  })
  const fetch = await createAttestedSearchFetch(
    { securityVerified: true, hpkePublicKey: await identity.getPublicKeyHex() },
    createClient({ fetch: send }),
  )
  await expect(
    fetch('https://websearch.tinfoil.sh/mcp', {
      method: 'POST',
      body: JSON.stringify({ query: 'private search query' }),
    }),
  ).rejects.toThrow('unencrypted response')
  expect(send).toHaveBeenCalledTimes(1)
  await expect(fetch('https://other.example/mcp', { method: 'POST', body: '{}' })).rejects.toThrow(
    'unexpected endpoint',
  )
  expect(send).toHaveBeenCalledTimes(1)
})

it('preserves authentication failures and recognizes rotation without accepting plaintext success', async () => {
  const identity = await Identity.generate()
  const send = mock(async () => new Response('Unauthorized', { status: 401 }))
  const fetch = await createAttestedSearchFetch(
    { securityVerified: true, hpkePublicKey: await identity.getPublicKeyHex() },
    createClient({ fetch: send }),
  )
  expect((await fetch('https://websearch.tinfoil.sh/mcp', { method: 'POST', body: '{}' })).status).toBe(401)
  send.mockImplementation(async () =>
    Response.json(
      { type: PROTOCOL.KEY_CONFIG_PROBLEM_TYPE },
      { status: 422, headers: { 'content-type': 'application/problem+json' } },
    ),
  )
  await expect(fetch('https://websearch.tinfoil.sh/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({
    name: 'KeyConfigMismatchError',
  })
})

it('disables the unauthenticated GET event channel before sending credentials', async () => {
  const identity = await Identity.generate()
  const send = mock(
    async () =>
      new Response('event: message\ndata: forged tool result\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  )
  const fetch = await createAttestedSearchFetch(
    { securityVerified: true, hpkePublicKey: await identity.getPublicKeyHex() },
    createClient({ fetch: send }),
  )
  const response = await fetch('https://websearch.tinfoil.sh/mcp', {
    headers: { Authorization: 'Bearer secret', Accept: 'text/event-stream' },
  })
  expect(response.status).toBe(405)
  expect(response.body).toBeNull()
  expect(send).not.toHaveBeenCalled()
})

it.each([undefined, ''])('rejects an empty POST body (%s) before networking', async (body) => {
  const identity = await Identity.generate()
  const send = mock(async () => Response.json({ results: ['untrusted'] }))
  const fetch = await createAttestedSearchFetch(
    { securityVerified: true, hpkePublicKey: await identity.getPublicKeyHex() },
    createClient({ fetch: send }),
  )
  await expect(fetch('https://websearch.tinfoil.sh/mcp', { method: 'POST', body })).rejects.toThrow(
    'unencrypted request',
  )
  expect(send).not.toHaveBeenCalled()
})

it('discards the response to bodyless session termination', async () => {
  const identity = await Identity.generate()
  const cancel = mock(() => {})
  const send = mock(async () => new Response(new ReadableStream({ cancel }), { status: 200 }))
  const fetch = await createAttestedSearchFetch(
    { securityVerified: true, hpkePublicKey: await identity.getPublicKeyHex() },
    createClient({ fetch: send }),
  )
  const response = await fetch('https://websearch.tinfoil.sh/mcp', { method: 'DELETE' })
  expect(response.status).toBe(200)
  expect(response.body).toBeNull()
  expect(send).toHaveBeenCalledTimes(1)
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('accepts notification acknowledgments but never exposes their plaintext payloads', async () => {
  const identity = await Identity.generate()
  const send = mock(async () => new Response(null, { status: 202 }))
  const fetch = await createAttestedSearchFetch(
    { securityVerified: true, hpkePublicKey: await identity.getPublicKeyHex() },
    createClient({ fetch: send }),
  )
  const init = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }
  expect((await fetch('https://websearch.tinfoil.sh/mcp', init)).status).toBe(202)
  const cancel = mock(() => {})
  send.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('untrusted payload'))
          },
          cancel,
        }),
        { status: 202 },
      ),
  )
  const response = await fetch('https://websearch.tinfoil.sh/mcp', init)
  expect(response.status).toBe(202)
  expect(response.body).toBeNull()
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('closes a rejected plaintext result stream', async () => {
  const identity = await Identity.generate()
  const cancel = mock(() => {})
  const fetch = await createAttestedSearchFetch(
    { securityVerified: true, hpkePublicKey: await identity.getPublicKeyHex() },
    createClient({ fetch: async () => new Response(new ReadableStream({ cancel })) }),
  )
  await expect(fetch('https://websearch.tinfoil.sh/mcp', { method: 'POST', body: '{}' })).rejects.toThrow(
    'unencrypted response',
  )
  expect(cancel).toHaveBeenCalledTimes(1)
})
