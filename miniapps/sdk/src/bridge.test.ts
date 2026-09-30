/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The guest side of the bridge.
 *
 * This file had no tests at all, and the host-side suite cannot stand in for
 * it: it exercises Thunderbolt's half of the conversation, so guest origin
 * filtering, request/reply disambiguation and disconnect settlement were
 * covered by nothing. Two of them were broken.
 *
 * `window.parent` is the host here. `connect` refuses to run when
 * `window.parent === window`, so each test installs a fake parent that records
 * what the guest posted and can post back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { connect, protocolMarker, readTokenClaims, type Connection } from './bridge'

const hostOrigin = 'https://host.example'

type Posted = { id?: number; method?: string; params?: unknown; result?: unknown }

let posted: Posted[] = []
let realParent: Window

/**
 * Deliver a message as though the host had sent it.
 *
 * `source` is forced after construction: `MessageEvent`'s initialiser only
 * accepts a real `Window`, and the fake parent below is a plain object, so
 * passing it through the constructor silently leaves `source` null and every
 * message fails the bridge's `event.source !== window.parent` guard.
 *
 * `protocol` is added here rather than by each caller because the bridge drops
 * anything without it, and a test that forgot it would look like a logic bug.
 */
const fromHost = (data: Record<string, unknown>, origin = hostOrigin) => {
  const event = new MessageEvent('message', { data: { protocol: protocolMarker, ...data }, origin })
  Object.defineProperty(event, 'source', { value: window.parent, configurable: true })
  window.dispatchEvent(event)
}

/** The id of the last request the guest posted for `method`. */
const lastRequestId = (method: string): number => {
  const match = [...posted].reverse().find((entry) => entry.method === method)
  if (match?.id === undefined) {
    throw new Error(`no request posted for ${method}; saw ${posted.map((p) => p.method).join(', ')}`)
  }
  return match.id
}

beforeEach(() => {
  posted = []
  realParent = window.parent
  // A distinct object so `window.parent !== window` and `isEmbedded()` passes.
  const fakeParent = {
    postMessage: (payload: Posted) => {
      posted.push(payload)
    },
  }
  Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true, writable: true })
})

afterEach(() => {
  Object.defineProperty(window, 'parent', { value: realParent, configurable: true, writable: true })
})

/** Connect and answer the handshake, returning the live connection. */
const connected = async (): Promise<Connection> => {
  const pending = connect({ appName: 'Test App', hostOrigin, auth: true })
  fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/initialize'), result: { hostContext: { theme: 'dark' } } })
  return pending
}

describe('handshake', () => {
  it('posts initialize to the configured host origin and resolves with its context', async () => {
    const connection = await connected()

    expect(connection.hostContext.theme).toBe('dark')
    expect(posted[0]?.method).toBe('ui/initialize')
  })

  it('rejects rather than hanging when nothing is embedding us', async () => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true, writable: true })

    await expect(connect({ appName: 'Test App', hostOrigin })).rejects.toThrow('not embedded')
  })

  it('rejects when the host refuses the handshake', async () => {
    const pending = connect({ appName: 'Test App', hostOrigin })
    fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/initialize'), result: { error: { message: 'unknown app' } } })

    await expect(pending).rejects.toThrow('unknown app')
  })
})

describe('origin filtering', () => {
  it('ignores a reply from any origin but the host', async () => {
    const connection = await connected()
    const inFlight = connection.getAuthToken()
    const id = lastRequestId('ui/request-auth-token')

    // Same id, wrong origin: a page that framed us alongside the host must not
    // be able to answer on Thunderbolt's behalf.
    fromHost(
      { jsonrpc: '2.0', id, result: { token: 'forged', expiresAt: '2099-01-01T00:00:00Z' } },
      'https://evil.test',
    )
    fromHost({ jsonrpc: '2.0', id, result: { token: 'real', expiresAt: '2099-01-01T00:00:00Z' } })

    expect((await inFlight)?.token).toBe('real')
  })
})

describe('request lifecycle', () => {
  it('settles a request the host answers with an error', async () => {
    const connection = await connected()
    const inFlight = connection.getAuthToken()

    fromHost({ jsonrpc: '2.0', id: lastRequestId('ui/request-auth-token'), error: { message: 'no session' } })

    expect(await inFlight).toBeNull()
  })

  /*
   * The leak. `disconnect()` removed the listener and left `pending` untouched,
   * so nothing could ever answer an in-flight request and the caller's `await`
   * never returned — an unmounted component's token request hung for the life
   * of the page.
   */
  it('settles in-flight requests on disconnect instead of leaving them pending', async () => {
    const connection = await connected()
    const inFlight = connection.getAuthToken()

    connection.disconnect()

    expect(await inFlight).toBeNull()
  })

  it('ignores a reply that arrives after disconnect', async () => {
    const connection = await connected()
    const inFlight = connection.getAuthToken()
    const id = lastRequestId('ui/request-auth-token')

    connection.disconnect()
    fromHost({ jsonrpc: '2.0', id, result: { token: 'late', expiresAt: '2099-01-01T00:00:00Z' } })

    expect(await inFlight).toBeNull()
  })
})

describe('notifications', () => {
  it('sends context as a notification, with no id to answer', async () => {
    const connection = await connected()

    connection.sendContext({ title: 'T', summary: 'S' })

    const update = posted.find((entry) => entry.method === 'ui/update-model-context')
    expect(update).toBeDefined()
    expect(update?.id).toBeUndefined()
  })

  it('truncates a reported error to the length the host accepts', async () => {
    const connection = await connected()

    connection.reportError('x'.repeat(900))

    const report = posted.find((entry) => entry.method === 'ui/notifications/error')
    expect((report?.params as { message: string }).message).toHaveLength(500)
  })
})

describe('readTokenClaims', () => {
  /** base64url over UTF-8, the way a real issuer encodes a payload. */
  const encodePayload = (claims: Record<string, unknown>) => {
    const utf8 = new TextEncoder().encode(JSON.stringify(claims))
    const binary = String.fromCharCode(...utf8)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  /*
   * `atob` yields one char per byte, so a Latin-1 read of a UTF-8 payload
   * mangled any non-ASCII name — and silently, because the mangled bytes are
   * still valid JSON. Exactly the case this function documents itself as being
   * for: putting a name in the corner of the UI.
   */
  it('decodes a non-ASCII name rather than mojibake', () => {
    const token = `header.${encodePayload({ name: 'Jürgen Müller', email: 'jm@example.de' })}.signature`

    expect(readTokenClaims(token)?.name).toBe('Jürgen Müller')
  })

  it('decodes a non-Latin name', () => {
    const token = `header.${encodePayload({ name: '田中太郎', email: 't@example.jp' })}.signature`

    expect(readTokenClaims(token)?.name).toBe('田中太郎')
  })

  it('returns null for a token with no payload segment', () => {
    expect(readTokenClaims('nonsense')).toBeNull()
  })

  it('returns null rather than throwing on a payload that is not JSON', () => {
    expect(readTokenClaims('header.bm90LWpzb24.signature')).toBeNull()
  })
})
