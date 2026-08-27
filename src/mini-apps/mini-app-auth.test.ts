/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { fetchMiniAppToken } from './mini-app-auth'

const realFetch = globalThis.fetch

const stubFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const valid = { token: 'header.payload.signature', expiresAt: new Date(Date.now() + 300_000).toISOString() }

describe('fetchMiniAppToken', () => {
  it('posts to the app-scoped endpoint and returns the token', async () => {
    let seenUrl = ''
    let seenMethod = ''
    stubFetch((url, init) => {
      seenUrl = url
      seenMethod = init?.method ?? ''
      return Response.json(valid)
    })

    expect(await fetchMiniAppToken('http://localhost:8000', 'patient-journeys')).toEqual(valid)
    expect(seenUrl).toBe('http://localhost:8000/mini-apps/patient-journeys/token')
    expect(seenMethod).toBe('POST')
  })

  it('encodes the app id rather than trusting it in a URL', async () => {
    let seenUrl = ''
    stubFetch((url) => {
      seenUrl = url
      return Response.json(valid)
    })

    await fetchMiniAppToken('http://localhost:8000', '../powersync')
    expect(seenUrl).toBe('http://localhost:8000/mini-apps/..%2Fpowersync/token')
  })

  /**
   * A Mini App that can't get an identity is degraded, not broken — the frame
   * still loads and the bridge still works, so none of these may throw.
   */
  it('returns null when the host declines to issue one', async () => {
    stubFetch(() => new Response('nope', { status: 404 }))
    expect(await fetchMiniAppToken('http://localhost:8000', 'unknown')).toBeNull()
  })

  it('returns null when the request fails outright', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    expect(await fetchMiniAppToken('http://localhost:8000', 'patient-journeys')).toBeNull()
  })

  it('returns null on a 200 whose body is not a token', async () => {
    stubFetch(() => Response.json({ token: 'only-half-a-payload' }))
    expect(await fetchMiniAppToken('http://localhost:8000', 'patient-journeys')).toBeNull()
  })

  it('returns null when the body is not JSON at all', async () => {
    stubFetch(() => new Response('<html>gateway</html>', { status: 200 }))
    expect(await fetchMiniAppToken('http://localhost:8000', 'patient-journeys')).toBeNull()
  })
})
