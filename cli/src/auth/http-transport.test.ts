/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wire-contract coverage for the fetch-backed transport, exercised with an
 * injected `fetchFn` (DI over mocking — no global `fetch` patched). Pins the two
 * load-bearing invariants: the approval token is taken from the `set-auth-token`
 * header (never the unsignable raw `access_token` body), and the RFC 8628 §3.5
 * error codes map to the right poll results.
 */

import { describe, expect, it } from 'bun:test'
import { cliClientId } from './config.ts'
import { createHttpTransport, type FetchFn } from './http-transport.ts'

const authBase = 'https://api.test/v1/api/auth'

/** A fetch fn that records requests and returns one scripted response. */
const stubFetch = (response: Response) => {
  const requests: { url: string; body: unknown }[] = []
  const fetchFn: FetchFn = async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init.body)) })
    return response
  }
  return { fetchFn, requests }
}

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init })

describe('createHttpTransport.requestCode', () => {
  it('posts the client id and normalizes the snake_case body to camelCase', async () => {
    const { fetchFn, requests } = stubFetch(
      jsonResponse({
        device_code: 'dc',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://api.test/device',
        verification_uri_complete: 'https://api.test/device?user_code=WDJB-MJHT',
        interval: 5,
        expires_in: 1800,
      }),
    )

    const code = await createHttpTransport(authBase, fetchFn).requestCode()

    expect(code).toEqual({
      deviceCode: 'dc',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://api.test/device',
      verificationUriComplete: 'https://api.test/device?user_code=WDJB-MJHT',
      intervalSeconds: 5,
      expiresInSeconds: 1800,
    })
    expect(requests[0].url).toBe(`${authBase}/device/code`)
    expect(requests[0].body).toEqual({ client_id: cliClientId })
  })

  it('throws when the code request is rejected', async () => {
    const { fetchFn } = stubFetch(jsonResponse({ error: 'invalid_client' }, { status: 400, statusText: 'Bad Request' }))
    await expect(createHttpTransport(authBase, fetchFn).requestCode()).rejects.toThrow(
      /device authorization request failed/,
    )
  })
})

describe('createHttpTransport.pollToken', () => {
  it('returns the signed set-auth-token header, not the raw access_token body', async () => {
    const { fetchFn, requests } = stubFetch(
      jsonResponse(
        { access_token: 'RAW-UNSIGNED-SESSION-TOKEN', token_type: 'Bearer' },
        { headers: { 'set-auth-token': 'SIGNED.hmac' } },
      ),
    )

    const result = await createHttpTransport(authBase, fetchFn).pollToken('dc')

    expect(result).toEqual({ kind: 'approved', token: 'SIGNED.hmac' })
    expect(requests[0].url).toBe(`${authBase}/device/token`)
    expect(requests[0].body).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dc',
      client_id: cliClientId,
    })
  })

  it('throws when a 200 approval is missing the set-auth-token header', async () => {
    const { fetchFn } = stubFetch(jsonResponse({ access_token: 'RAW' }))
    await expect(createHttpTransport(authBase, fetchFn).pollToken('dc')).rejects.toThrow(/set-auth-token/)
  })

  it('maps the RFC 8628 §3.5 error codes to poll results', async () => {
    const cases = [
      ['authorization_pending', { kind: 'pending' }],
      ['slow_down', { kind: 'slow_down' }],
      ['expired_token', { kind: 'expired' }],
      ['access_denied', { kind: 'denied' }],
    ] as const

    for (const [error, expected] of cases) {
      const { fetchFn } = stubFetch(jsonResponse({ error }, { status: 400 }))
      expect(await createHttpTransport(authBase, fetchFn).pollToken('dc')).toEqual(expected)
    }
  })

  it('throws on an unrecognized error code', async () => {
    const { fetchFn } = stubFetch(jsonResponse({ error: 'invalid_grant' }, { status: 400 }))
    await expect(createHttpTransport(authBase, fetchFn).pollToken('dc')).rejects.toThrow(/invalid_grant/)
  })
})
