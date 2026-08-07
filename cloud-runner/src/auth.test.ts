/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { encodeWsBearer, extractBearerSubprotocol, wsCarrierSubprotocol } from '../../shared/ws-bearer.ts'
import { authorizeConnection, extractBearerHeader, introspectBearer } from './auth.ts'

const bearer = 'raw-session-token.c2lnbmF0dXJl'
const header = `${wsCarrierSubprotocol}, thunderbolt.bearer.${encodeWsBearer(bearer)}`

const fetchReturning = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('extractBearerSubprotocol', () => {
  test('decodes the bearer entry among offered subprotocols', () => {
    expect(extractBearerSubprotocol(header)).toBe(bearer)
  })

  test('returns null without a bearer entry', () => {
    expect(extractBearerSubprotocol(wsCarrierSubprotocol)).toBeNull()
    expect(extractBearerSubprotocol(null)).toBeNull()
  })
})

describe('introspectBearer', () => {
  test('resolves the user for a valid session', async () => {
    const fetchFn = fetchReturning(200, { user: { id: 'u1', email: 'a@b.c', isAnonymous: false } })
    expect(await introspectBearer('https://api.example', bearer, fetchFn)).toEqual({ id: 'u1', email: 'a@b.c' })
  })

  test('rejects anonymous sessions', async () => {
    const fetchFn = fetchReturning(200, { user: { id: 'u1', isAnonymous: true } })
    expect(await introspectBearer('https://api.example', bearer, fetchFn)).toBeNull()
  })

  test('rejects missing sessions (null body) and backend errors', async () => {
    expect(await introspectBearer('https://api.example', bearer, fetchReturning(200, null))).toBeNull()
    expect(await introspectBearer('https://api.example', bearer, fetchReturning(401, {}))).toBeNull()
  })

  test('sends the bearer to the backend session endpoint', async () => {
    const seen = { url: '', auth: null as string | null }
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url)
      seen.auth = new Headers(init?.headers).get('authorization')
      return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })
    }) as unknown as typeof fetch
    await introspectBearer('https://api.example', bearer, fetchFn)
    expect(seen.url).toBe('https://api.example/v1/api/auth/get-session')
    expect(seen.auth).toBe(`Bearer ${bearer}`)
  })
})

describe('extractBearerHeader', () => {
  test('reads the token from an Authorization header', () => {
    expect(extractBearerHeader(`Bearer ${bearer}`)).toBe(bearer)
  })

  test('ignores absent, empty, and non-bearer schemes', () => {
    expect(extractBearerHeader(null)).toBeNull()
    expect(extractBearerHeader('Bearer   ')).toBeNull()
    expect(extractBearerHeader(`Basic ${bearer}`)).toBeNull()
  })
})

describe('authorizeConnection', () => {
  test('authorizes a header carrying a valid bearer and keeps the bearer for model calls', async () => {
    const fetchFn = fetchReturning(200, { user: { id: 'u1' } })
    expect(await authorizeConnection('https://api.example', header, fetchFn)).toEqual({
      user: { id: 'u1', email: null },
      bearer,
    })
  })

  test('rejects a bearer the backend does not recognize', async () => {
    const fetchFn = fetchReturning(401, {})
    expect(await authorizeConnection('https://api.example', header, fetchFn)).toBeNull()
  })

  test('rejects a header without a bearer without calling the backend', async () => {
    const fetchFn = (async () => {
      throw new Error('must not be called')
    }) as unknown as typeof fetch
    expect(await authorizeConnection('https://api.example', wsCarrierSubprotocol, fetchFn)).toBeNull()
  })
})
