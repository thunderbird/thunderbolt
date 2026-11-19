/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { http } from '@/lib/http'
import { nativeFetch } from '@/lib/native-fetch'
import * as nativeTransport from '@/lib/native-fetch'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import { stubJsonResponse } from '@/test-utils/http'
import { chatGPTIssuer, chatGPTResource, loadChatGPTMetadata, revokeChatGPTSession } from './chatgpt-session'
import type { ProviderCredentials } from './types'

const metadata = {
  issuer: chatGPTIssuer,
  authorization_endpoint: `${chatGPTIssuer}/authorize`,
  token_endpoint: `${chatGPTIssuer}/token`,
  jwks_uri: `${chatGPTIssuer}/jwks`,
  revocation_endpoint: `${chatGPTIssuer}/revoke`,
} satisfies Awaited<ReturnType<typeof loadChatGPTMetadata>>
const credentials = {
  refresh_token: 'refresh-token',
  oauth: {
    issuer: chatGPTIssuer,
    clientId: 'client-id',
    tokenEndpoint: metadata.token_endpoint,
    resource: chatGPTResource,
  },
} satisfies ProviderCredentials

afterEach(() => mock.restore())

test('discovers metadata without cookies or redirects and keeps caller cancellation', async () => {
  const get = spyOn(http, 'get').mockReturnValue(stubJsonResponse(metadata))
  const controller = new AbortController()
  expect(await loadChatGPTMetadata(controller.signal)).toEqual(metadata)
  expect(get).toHaveBeenCalledWith(`${chatGPTIssuer}/.well-known/openid-configuration`, {
    fetch: nativeFetch,
    redirect: 'error',
    credentials: 'omit',
    signal: expect.any(AbortSignal),
  })
  const signal = get.mock.calls[0]?.[1]?.signal
  controller.abort()
  expect(signal?.aborted).toBe(true)
})

test.each(['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint'] as const)(
  'rejects a foreign %s before credentials can be sent',
  async (endpoint) => {
    spyOn(http, 'get').mockReturnValue(stubJsonResponse({ ...metadata, [endpoint]: 'https://attacker.example/' }))
    const post = spyOn(http, 'post')
    await expect(revokeChatGPTSession(credentials)).rejects.toThrow('Unexpected ChatGPT OAuth endpoint')
    expect(post).not.toHaveBeenCalled()
  },
)

test.each([
  'http://auth.openai.com/revoke',
  'https://user:password@auth.openai.com/revoke',
  'https://auth.openai.com/revoke#fragment',
])('rejects an unsafe revocation URL %s', async (revocationEndpoint) => {
  spyOn(http, 'get').mockReturnValue(stubJsonResponse({ ...metadata, revocation_endpoint: revocationEndpoint }))
  await expect(loadChatGPTMetadata()).rejects.toThrow('Unexpected ChatGPT OAuth endpoint')
})

test('rejects metadata for another issuer', async () => {
  spyOn(http, 'get').mockReturnValue(stubJsonResponse({ ...metadata, issuer: 'https://attacker.example' }))
  await expect(loadChatGPTMetadata()).rejects.toThrow()
})

test('revokes the refresh token using the validated endpoint and its registered client', async () => {
  spyOn(http, 'get').mockReturnValue(stubJsonResponse(metadata))
  const post = spyOn(http, 'post').mockReturnValue(stubJsonResponse({}))
  await revokeChatGPTSession(credentials)
  expect(post).toHaveBeenCalledWith(metadata.revocation_endpoint, {
    fetch: nativeFetch,
    redirect: 'error',
    credentials: 'omit',
    signal: expect.any(AbortSignal),
    body: new URLSearchParams({ token: 'refresh-token', token_type_hint: 'refresh_token', client_id: 'client-id' }),
  })
})

test.each([{}, { refresh_token: 'refresh-token' }, { oauth: credentials.oauth }])(
  'does not contact the issuer without a renewable registered session: %j',
  async (session) => {
    const get = spyOn(http, 'get')
    const post = spyOn(http, 'post')
    await revokeChatGPTSession(session)
    expect(get).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  },
)

test('surfaces revocation failures to the caller so a disconnect remains retryable', async () => {
  spyOn(http, 'get').mockReturnValue(stubJsonResponse(metadata))
  const failure = new Error('issuer unavailable')
  spyOn(http, 'post').mockImplementation(() => {
    throw failure
  })
  await expect(revokeChatGPTSession(credentials)).rejects.toBe(failure)
})

test.each(['discovery', 'revocation'] as const)(
  'finishes bounded ChatGPT cleanup when identity teardown interrupts %s',
  async (phase) => {
    const started = Promise.withResolvers<Request>()
    const pending = Promise.withResolvers<Response>()
    const deadline = new AbortController()
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const requests: Request[] = []
    spyOn(nativeTransport, 'nativeFetch').mockImplementation(async (input) => {
      const request = input as Request
      requests.push(request)
      if ((phase === 'revocation') === (request.url === metadata.revocation_endpoint)) {
        started.resolve(request)
        return pending.promise
      }
      return Response.json(metadata)
    })
    const revoking = revokeChatGPTSession(credentials)
    const request = await started.promise
    invalidateIdentityLifetime()
    const abortedByIdentity = request.signal.aborted
    pending.resolve(phase === 'discovery' ? Response.json(metadata) : new Response(null, { status: 204 }))
    await revoking
    expect(abortedByIdentity).toBe(false)
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(30_000)
    expect(requests.map((request) => request.url)).toEqual([
      `${chatGPTIssuer}/.well-known/openid-configuration`,
      metadata.revocation_endpoint,
    ])
    deadline.abort(new DOMException('Timed out', 'TimeoutError'))
    expect(requests.every((request) => request.signal.aborted)).toBe(true)
  },
)
