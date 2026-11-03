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
