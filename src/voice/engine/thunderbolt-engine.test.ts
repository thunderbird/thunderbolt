/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  appVersionUnsupported,
  isAppVersionBlocked,
  resetAppVersionBlockedForTesting,
} from '@/lib/app-version-unsupported'
import { createTinfoilTransport } from './thunderbolt-engine'

/** Fake attested client capturing the last request so the transport can be
 *  driven without attestation or a network. */
const fakeClient = (respond: () => Response) => {
  let received: { input: RequestInfo | URL; init?: RequestInit } | null = null
  const client = {
    getBaseURL: () => 'https://cloud.example.com/v1/tinfoil',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      received = { input, init }
      return Promise.resolve(respond())
    }) as typeof fetch,
  }
  return { client, received: () => received }
}

const createTransport = (respond: () => Response, overrides?: { token?: string | null; sso?: boolean }) => {
  const fake = fakeClient(respond)
  const transport = createTinfoilTransport({
    getClient: async () => fake.client,
    evictClient: () => {},
    isSsoMode: () => overrides?.sso ?? false,
    getAuthToken: () => (overrides?.token === undefined ? 'session-token' : overrides.token),
  })
  return { transport, received: fake.received }
}

describe('createTinfoilTransport', () => {
  const env = import.meta.env as Record<string, unknown>
  let savedVersion: unknown

  beforeEach(() => {
    savedVersion = env.VITE_APP_VERSION
  })

  afterEach(() => {
    env.VITE_APP_VERSION = savedVersion
    resetAppVersionBlockedForTesting()
  })

  // The /tinfoil route is behind the backend's fail-closed version gate: a
  // request without X-App-Version 426s even on a current build.
  it('sends X-App-Version alongside the auth header', async () => {
    env.VITE_APP_VERSION = '1.2.3'
    const { transport, received } = createTransport(() => new Response('ok'))

    await transport('/audio/transcriptions', 'body')

    const headers = new Headers(received()?.init?.headers)
    expect(headers.get('X-App-Version')).toBe('1.2.3')
    expect(headers.get('Authorization')).toBe('Bearer session-token')
    expect(received()?.input).toBe('https://cloud.example.com/v1/tinfoil/audio/transcriptions')
  })

  it('omits X-App-Version when VITE_APP_VERSION is unset', async () => {
    env.VITE_APP_VERSION = undefined
    const { transport, received } = createTransport(() => new Response('ok'))

    await transport('/audio/speech', 'body')

    expect(new Headers(received()?.init?.headers).has('X-App-Version')).toBe(false)
  })

  it('raises the upgrade blocker on a 426 and still returns the response', async () => {
    const events: CustomEvent[] = []
    const listener = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener(appVersionUnsupported, listener)
    const { transport } = createTransport(() => new Response(null, { status: 426 }))

    const response = await transport('/audio/transcriptions', 'body')

    expect(response.status).toBe(426)
    expect(isAppVersionBlocked()).toBe(true)
    expect(events).toHaveLength(1)
    window.removeEventListener(appVersionUnsupported, listener)
  })

  it('does not raise the blocker on other error statuses', async () => {
    const { transport } = createTransport(() => new Response(null, { status: 500 }))

    const response = await transport('/audio/transcriptions', 'body')

    expect(response.status).toBe(500)
    expect(isAppVersionBlocked()).toBe(false)
  })

  it('sends cookies instead of a bearer header in SSO mode without a token', async () => {
    const { transport, received } = createTransport(() => new Response('ok'), { token: null, sso: true })

    await transport('/audio/transcriptions', 'body')

    expect(received()?.init?.credentials).toBe('include')
    expect(new Headers(received()?.init?.headers).has('Authorization')).toBe(false)
  })

  it('retries once through a fresh client on a 422 key mismatch and gates the final response', async () => {
    const statuses = [422, 426]
    let evicted = 0
    const fake = fakeClient(() => new Response(null, { status: statuses.shift()! }))
    const transport = createTinfoilTransport({
      getClient: async () => fake.client,
      evictClient: () => {
        evicted++
      },
      isSsoMode: () => false,
      getAuthToken: () => 'session-token',
    })

    const response = await transport('/audio/transcriptions', 'body')

    expect(evicted).toBe(1)
    expect(response.status).toBe(426)
    expect(isAppVersionBlocked()).toBe(true)
  })
})
