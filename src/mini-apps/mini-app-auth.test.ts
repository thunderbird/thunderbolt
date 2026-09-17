/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createAuthenticatedClient } from '@/lib/http'
import { fetchMiniAppToken } from './mini-app-auth'

/** The real client with its fetch injected, so the auth and 401 handling this
 *  function now relies on are exercised rather than stubbed away. */
const clientWith = (handler: (request: Request) => Response | Promise<Response>) =>
  createAuthenticatedClient('http://localhost:8000', () => 'session-token', {
    fetch: ((input: Request) => Promise.resolve(handler(input))) as typeof fetch,
  })

const valid = { token: 'header.payload.signature', expiresAt: new Date(Date.now() + 300_000).toISOString() }

describe('fetchMiniAppToken', () => {
  /** A cast asserted this shape without checking it, so a wrong-typed body
   *  reached the guest as if it were a JWS. */
  it('refuses a body that is not a token', async () => {
    const client = clientWith(() => Response.json({ token: 7, expiresAt: 7 }))

    expect(await fetchMiniAppToken(client, 'patient-journeys')).toBeNull()
  })

  it('refuses a token with an empty string', async () => {
    const client = clientWith(() => Response.json({ token: '', expiresAt: '' }))

    expect(await fetchMiniAppToken(client, 'patient-journeys')).toBeNull()
  })

  it('posts to the app-scoped endpoint and returns the token', async () => {
    let seen: Request | null = null
    const client = clientWith((request) => {
      seen = request
      return Response.json(valid)
    })

    expect(await fetchMiniAppToken(client, 'patient-journeys')).toEqual(valid)
    expect(seen!.url).toBe('http://localhost:8000/mini-apps/patient-journeys/token')
    expect(seen!.method).toBe('POST')
  })

  /** The whole reason this moved off a bare `fetch`. */
  it('carries the session bearer token', async () => {
    let seen: Request | null = null
    const client = clientWith((request) => {
      seen = request
      return Response.json(valid)
    })

    await fetchMiniAppToken(client, 'patient-journeys')
    expect(seen!.headers.get('Authorization')).toBe('Bearer session-token')
  })

  it('encodes the app id rather than trusting it in a URL', async () => {
    let seenUrl = ''
    const client = clientWith((request) => {
      seenUrl = request.url
      return Response.json(valid)
    })

    await fetchMiniAppToken(client, '../powersync')
    expect(seenUrl).toBe('http://localhost:8000/mini-apps/..%2Fpowersync/token')
  })

  /**
   * A Mini App that can't get an identity is degraded, not broken — the frame
   * still loads and the bridge still works, so none of these may throw.
   */
  it('returns null when the host declines to issue one', async () => {
    expect(
      await fetchMiniAppToken(
        clientWith(() => new Response('nope', { status: 404 })),
        'unknown',
      ),
    ).toBeNull()
  })

  it('returns null when the request fails outright', async () => {
    const client = clientWith(() => Promise.reject(new Error('offline')))
    expect(await fetchMiniAppToken(client, 'patient-journeys')).toBeNull()
  })

  it('returns null on a 200 whose body is not a token', async () => {
    const client = clientWith(() => Response.json({ token: 'only-half-a-payload' }))
    expect(await fetchMiniAppToken(client, 'patient-journeys')).toBeNull()
  })

  it('returns null when the body is not JSON at all', async () => {
    const client = clientWith(() => new Response('<html>gateway</html>', { status: 200 }))
    expect(await fetchMiniAppToken(client, 'patient-journeys')).toBeNull()
  })
})
