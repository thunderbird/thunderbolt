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
import { cliVersion } from '../version.ts'
import { cliClientId } from './config.ts'
import { createHttpTransport, type FetchFn } from './http-transport.ts'

const authBase = 'https://api.test/v1/api/auth'

/** A fetch fn that records requests and returns one scripted response. */
const stubFetch = (response: Response) => {
  const requests: { url: string; init: RequestInit; body: unknown }[] = []
  const fetchFn: FetchFn = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) })
    return response
  }
  return { fetchFn, requests }
}

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init })

describe('createHttpTransport.requestCode', () => {
  it('posts the client id with redirect protection and normalizes the snake_case body to camelCase', async () => {
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
    expect(requests[0].init.method).toBe('POST')
    const headers = new Headers(requests[0].init.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-app-version')).toBe(cliVersion)
    expect(requests[0].init.redirect).toBe('error')
    expect(requests[0].body).toEqual({ client_id: cliClientId })
  })

  it('throws when the code request is rejected', async () => {
    const { fetchFn } = stubFetch(jsonResponse({ error: 'invalid_client' }, { status: 400, statusText: 'Bad Request' }))
    await expect(createHttpTransport(authBase, fetchFn).requestCode()).rejects.toThrow(
      /device authorization request failed/,
    )
  })

  it('surfaces a redirect rejection from fetch', async () => {
    const fetchFn: FetchFn = async (_url, init) => {
      if (init.redirect !== 'error') throw new Error('redirect protection is required')
      throw new TypeError('redirect rejected by fetch')
    }

    await expect(createHttpTransport(authBase, fetchFn).requestCode()).rejects.toThrow('redirect rejected by fetch')
  })

  it('forwards an abort signal to the device code request', async () => {
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
    const controller = new AbortController()

    await createHttpTransport(authBase, fetchFn).requestCode(controller.signal)

    expect(requests[0]?.init.signal).toBe(controller.signal)
  })
})

describe('createHttpTransport.pollToken', () => {
  it('uses redirect protection and returns the signed set-auth-token header, not the raw access_token body', async () => {
    const { fetchFn, requests } = stubFetch(
      jsonResponse(
        { access_token: 'RAW-UNSIGNED-SESSION-TOKEN', token_type: 'Bearer' },
        { headers: { 'set-auth-token': 'SIGNED.hmac' } },
      ),
    )

    const result = await createHttpTransport(authBase, fetchFn).pollToken('dc')

    expect(result).toEqual({ kind: 'approved', token: 'SIGNED.hmac' })
    expect(requests[0].url).toBe(`${authBase}/device/token`)
    expect(requests[0].init.method).toBe('POST')
    const headers = new Headers(requests[0].init.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-app-version')).toBe(cliVersion)
    expect(requests[0].init.redirect).toBe('error')
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

  it('surfaces a redirect rejection from fetch', async () => {
    const fetchFn: FetchFn = async (_url, init) => {
      if (init.redirect !== 'error') throw new Error('redirect protection is required')
      throw new TypeError('redirect rejected by fetch')
    }

    await expect(createHttpTransport(authBase, fetchFn).pollToken('dc')).rejects.toThrow('redirect rejected by fetch')
  })

  it('forwards an abort signal to token polling requests', async () => {
    const { fetchFn, requests } = stubFetch(jsonResponse({ error: 'authorization_pending' }, { status: 400 }))
    const controller = new AbortController()

    await createHttpTransport(authBase, fetchFn).pollToken('dc', controller.signal)

    expect(requests[0]?.init.signal).toBe(controller.signal)
  })
})
