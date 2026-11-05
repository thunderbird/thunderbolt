/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it, spyOn } from 'bun:test'
import { Identity } from 'ehbp'
import * as nativeTransport from '@/lib/native-fetch'
import { createBrowserSearchClient, nativeSearchClient } from './http-client'
import { createAttestedSearchFetch } from './attested-fetch'

it('sends only the encrypted search body to the same-origin relay without cookies or redirects', async () => {
  const identity = await Identity.generate()
  const client = createBrowserSearchClient('https://app.example', async (input) => {
    const request = input as Request
    expect(request.url).toBe('https://app.example/_tinfoil/search')
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')
    expect(request.headers.get('authorization')).toBe('Bearer test-provider-token')
    expect(request.headers.has('ehbp-encapsulated-key')).toBe(true)
    expect(await request.text()).not.toContain('private query')
    return new Response('Unauthorized', { status: 401 })
  })
  const send = await createAttestedSearchFetch(
    { securityVerified: true, hpkePublicKey: await identity.getPublicKeyHex() },
    client,
  )
  expect(
    (
      await send('https://websearch.tinfoil.sh/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer test-provider-token' },
        body: '{"query":"private query"}',
      })
    ).status,
  ).toBe(401)
})

it('always uses native transport for native search, independently of Cloud authentication', async () => {
  const send = spyOn(nativeTransport, 'nativeFetch').mockResolvedValue(new Response('{}'))
  try {
    await nativeSearchClient.get('https://websearch.tinfoil.sh/mcp')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][1]?.redirect).toBe('error')
  } finally {
    send.mockRestore()
  }
})
