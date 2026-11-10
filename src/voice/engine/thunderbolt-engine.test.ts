/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
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
    baseURL: 'https://cloud.example.com/v1/tinfoil',
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
    if (savedVersion === undefined) {
      delete env.VITE_APP_VERSION
    } else {
      env.VITE_APP_VERSION = savedVersion
    }
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
    delete env.VITE_APP_VERSION
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

  it('sends no bearer token or cookies in consumer mode without a token', async () => {
    const { transport, received } = createTransport(() => new Response(), { token: null })
    await transport('/audio/transcriptions', 'body')
    expect(received()?.init?.credentials).toBeUndefined()
    expect(new Headers(received()?.init?.headers).has('Authorization')).toBe(false)
  })

  it('returns an ordinary 422 response without replay or eviction', async () => {
    const respond = mock(() => new Response(null, { status: 422 }))
    const fake = fakeClient(respond)
    const evictClient = mock(() => {})
    const transport = createTinfoilTransport({
      getClient: async () => fake.client,
      evictClient,
      isSsoMode: () => false,
      getAuthToken: () => 'token',
    })

    expect((await transport('/audio/transcriptions', 'body')).status).toBe(422)
    expect(respond).toHaveBeenCalledTimes(1)
    expect(evictClient).not.toHaveBeenCalled()
  })

  it('evicts a failed attestation without replaying the request', async () => {
    const failure = Object.assign(new Error('attestation rejected'), { category: 'attestation' })
    const respond = mock(() => {
      throw failure
    })
    const { client } = fakeClient(respond)
    const getClient = mock(async () => client)
    const evictClient = mock(() => {})
    const transport = createTinfoilTransport({
      getClient,
      evictClient,
      isSsoMode: () => false,
      getAuthToken: () => 'token',
    })

    await expect(transport('/audio/transcriptions', 'body')).rejects.toBe(failure)
    expect(respond).toHaveBeenCalledTimes(1)
    expect(getClient).toHaveBeenCalledTimes(1)
    expect(evictClient).toHaveBeenCalledTimes(1)
    expect(evictClient).toHaveBeenCalledWith(client)
  })

  it('propagates unrelated errors without eviction or retry', async () => {
    const error = new Error('network unavailable')
    const client = fakeClient(() => {
      throw error
    }).client
    const getClient = mock(async () => client)
    const evictClient = mock(() => {})
    const transport = createTinfoilTransport({
      getClient,
      evictClient,
      isSsoMode: () => false,
      getAuthToken: () => 'token',
    })
    await expect(transport('/audio/transcriptions', 'body')).rejects.toBe(error)
    expect(getClient).toHaveBeenCalledTimes(1)
    expect(evictClient).not.toHaveBeenCalled()
  })
})
