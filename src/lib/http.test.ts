/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { setActiveLocale } from '@/i18n/active-locale'
import { appVersionUnsupported, resetAppVersionBlockedForTesting } from './app-version-unsupported'
import { createAuthenticatedClient, createClient, HttpError } from './http'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const mockFetch = (response: Partial<Response> = {}) => {
  const ok = response.ok ?? true
  const status = response.status ?? 200
  return mock<FetchFn>(() =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true }), {
        status,
        headers: { 'Content-Type': 'application/json' },
        ...(!ok && { status }),
      }),
    ),
  )
}

/** Create a client with the deployed relative prefix without leaking the test origin into later cases. */
const createRelativePrefixClient = (
  getToken: () => string | null,
  config: NonNullable<Parameters<typeof createAuthenticatedClient>[2]>,
): ReturnType<typeof createAuthenticatedClient> => {
  const previousUrl = window.location.href
  window.location.href = 'https://app.example.com/settings/devices'
  try {
    return createAuthenticatedClient('/v1', getToken, config)
  } finally {
    window.location.href = previousUrl
  }
}

describe('createClient', () => {
  it('makes GET requests', async () => {
    const fetch = mockFetch()
    const client = createClient({ fetch })
    await client.get('https://example.com/api')
    expect(fetch).toHaveBeenCalledTimes(1)
    const req = fetch.mock.calls[0][0] as Request
    expect(req.method).toBe('GET')
    expect(req.url).toBe('https://example.com/api')
  })

  it('makes POST requests with JSON body', async () => {
    const fetch = mockFetch()
    const client = createClient({ fetch })
    await client.post('https://example.com/api', { json: { name: 'test' } })
    const req = fetch.mock.calls[0][0] as Request
    expect(req.method).toBe('POST')
    expect(req.headers.get('Content-Type')).toBe('application/json')
    expect(await req.json()).toEqual({ name: 'test' })
  })

  it('appends search params', async () => {
    const fetch = mockFetch()
    const client = createClient({ fetch })
    await client.get('https://example.com/api', { searchParams: { q: 'hello', page: 1 } })
    const req = fetch.mock.calls[0][0] as Request
    expect(req.url).toBe('https://example.com/api?q=hello&page=1')
  })

  it('resolves URLs with prefixUrl', async () => {
    const fetch = mockFetch()
    const client = createClient({ prefixUrl: 'https://api.example.com', fetch })
    await client.get('users')
    const req = fetch.mock.calls[0][0] as Request
    expect(req.url).toBe('https://api.example.com/users')
  })

  it('does not prefix absolute URLs', async () => {
    const fetch = mockFetch()
    const client = createClient({ prefixUrl: 'https://api.example.com', fetch })
    await client.get('https://other.com/resource')
    const req = fetch.mock.calls[0][0] as Request
    expect(req.url).toBe('https://other.com/resource')
  })

  it('throws HttpError on non-2xx response', async () => {
    const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Not Found', { status: 404 })))
    const client = createClient({ fetch })
    await expect(client.get('https://example.com/missing')).rejects.toBeInstanceOf(HttpError)
  })

  it('passes custom headers through', async () => {
    const fetch = mockFetch()
    const client = createClient({ fetch })
    await client.get('https://example.com/api', {
      headers: { 'X-Custom': 'value' },
    })
    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('X-Custom')).toBe('value')
  })

  it('runs beforeRequest hooks', async () => {
    const fetch = mockFetch()
    const hook = mock<(req: Request) => void>(() => {})
    const client = createClient({ fetch, hooks: { beforeRequest: [hook] } })
    await client.get('https://example.com/api')
    expect(hook).toHaveBeenCalledTimes(1)
  })
})

describe('createAuthenticatedClient', () => {
  it('sets Authorization header when token is available', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })
    await client.get('data')
    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBe('Bearer app-token')
  })

  it('does not set Authorization header when token is null', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => null, { fetch })
    await client.get('data')
    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBeNull()
  })

  it('preserves caller-provided Authorization header (OAuth tokens)', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

    // Simulate what Google/Microsoft tools do: pass their own OAuth token
    await client.get('https://www.googleapis.com/gmail/v1/users/me/messages', {
      headers: { Authorization: 'Bearer google-oauth-token' },
    })

    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBe('Bearer google-oauth-token')
  })

  it('preserves caller-provided Authorization on POST requests', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

    await client.post('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
      json: { raw: 'base64data' },
      headers: { Authorization: 'Bearer google-oauth-token' },
    })

    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBe('Bearer google-oauth-token')
  })

  it('still sets app token when no Authorization header is provided', async () => {
    const fetch = mockFetch()
    const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

    // Normal app API call with other headers but no Authorization
    await client.get('data', { headers: { 'X-Custom': 'value' } })

    const req = fetch.mock.calls[0][0] as Request
    expect(req.headers.get('Authorization')).toBe('Bearer app-token')
    expect(req.headers.get('X-Custom')).toBe('value')
  })

  describe('device identity headers', () => {
    const deviceIdKey = 'thunderbolt_device_id'

    beforeEach(() => {
      localStorage.setItem(deviceIdKey, 'test-device-id')
    })

    afterEach(() => {
      localStorage.removeItem(deviceIdKey)
      setActiveLocale('en')
      localStorage.removeItem('thunderbolt_locale')
    })

    it('injects X-Device-ID and X-Device-Name for app backend requests (relative URL)', async () => {
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('data')

      const req = fetch.mock.calls[0][0] as Request
      expect(req.headers.get('X-Device-ID')).toBe('test-device-id')
      expect(req.headers.get('X-Device-Name')).toBeTruthy()
    })

    it('injects device headers for absolute URL matching prefixUrl', async () => {
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('https://api.example.com/v1/foo')

      const req = fetch.mock.calls[0][0] as Request
      expect(req.headers.get('X-Device-ID')).toBe('test-device-id')
      expect(req.headers.get('X-Device-Name')).toBeTruthy()
    })

    it('injects device headers when the backend prefix is relative', async () => {
      const fetch = mockFetch()
      const client = createRelativePrefixClient(() => 'app-token', { fetch })

      await client.post('account/devices/device-id/revoke')

      const req = fetch.mock.calls[0][0] as Request
      expect(req.url).toBe('https://app.example.com/v1/account/devices/device-id/revoke')
      expect(req.headers.get('X-Device-ID')).toBe('test-device-id')
      expect(req.headers.get('X-Device-Name')).toBeTruthy()
    })

    it('does NOT treat a same-origin path sharing only the prefix text as the backend', async () => {
      const fetch = mockFetch()
      const client = createRelativePrefixClient(() => 'app-token', { fetch })

      await client.get('https://app.example.com/v10/account/devices')

      const req = fetch.mock.calls[0][0] as Request
      expect(req.headers.get('X-Device-ID')).toBeNull()
      expect(req.headers.get('X-App-Version')).toBeNull()
    })

    it('does NOT inject device headers for external API URLs', async () => {
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('https://www.googleapis.com/gmail/v1/users/me/messages', {
        headers: { Authorization: 'Bearer google-oauth-token' },
      })

      const req = fetch.mock.calls[0][0] as Request
      expect(req.headers.get('X-Device-ID')).toBeNull()
      expect(req.headers.get('X-Device-Name')).toBeNull()
    })

    it('does NOT inject device headers for unrelated external URLs', async () => {
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('https://other.com/data')

      const req = fetch.mock.calls[0][0] as Request
      expect(req.headers.get('X-Device-ID')).toBeNull()
      expect(req.headers.get('X-Device-Name')).toBeNull()
    })

    it('injects X-App-Language for app backend requests', async () => {
      setActiveLocale('ja')
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('data')

      expect((fetch.mock.calls[0][0] as Request).headers.get('X-App-Language')).toBe('ja')
    })

    it('sends the locale switched to most recently', async () => {
      setActiveLocale('ja')
      setActiveLocale('pt-BR')
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('data')

      expect((fetch.mock.calls[0][0] as Request).headers.get('X-App-Language')).toBe('pt-BR')
    })

    it('does NOT leak X-App-Language to external API URLs', async () => {
      setActiveLocale('ja')
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('https://other.com/data')

      expect((fetch.mock.calls[0][0] as Request).headers.get('X-App-Language')).toBeNull()
    })
  })

  describe('X-App-Version header', () => {
    const env = import.meta.env as Record<string, unknown>
    let savedVersion: unknown

    beforeEach(() => {
      savedVersion = env.VITE_APP_VERSION
    })

    afterEach(() => {
      env.VITE_APP_VERSION = savedVersion
    })

    it('injects X-App-Version for app backend requests when set', async () => {
      env.VITE_APP_VERSION = '9.9.9'
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('data')

      const req = fetch.mock.calls[0][0] as Request
      expect(req.headers.get('X-App-Version')).toBe('9.9.9')
    })

    it('does NOT inject X-App-Version for external API URLs', async () => {
      env.VITE_APP_VERSION = '9.9.9'
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('https://other.com/data')

      const req = fetch.mock.calls[0][0] as Request
      expect(req.headers.get('X-App-Version')).toBeNull()
    })

    it('omits X-App-Version when VITE_APP_VERSION is unset', async () => {
      env.VITE_APP_VERSION = undefined
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('data')

      const req = fetch.mock.calls[0][0] as Request
      expect(req.headers.get('X-App-Version')).toBeNull()
    })
  })

  describe('session expiry detection', () => {
    const originalDispatch = window.dispatchEvent
    let dispatchSpy: ReturnType<typeof mock>

    beforeEach(() => {
      dispatchSpy = mock(() => true)
      window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
    })

    afterEach(() => {
      window.dispatchEvent = originalDispatch
    })

    it('dispatches powersync_credentials_invalid (session_expired) on 401 from app backend with app token', async () => {
      const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await expect(client.get('data')).rejects.toBeInstanceOf(HttpError)

      expect(dispatchSpy).toHaveBeenCalledTimes(1)
      const event = dispatchSpy.mock.calls[0][0] as CustomEvent
      expect(event.type).toBe('powersync_credentials_invalid')
      expect(event.detail).toEqual({ reason: 'session_expired' })
    })

    it('does not dispatch on 401 from external API even with caller-provided Authorization header (Google/MS OAuth)', async () => {
      // Integration tools (Google, Microsoft) reuse the same authenticated client but pass their
      // own OAuth tokens. A 401 from those external APIs must NOT clear the app session.
      const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await expect(
        client.get('https://www.googleapis.com/gmail/v1/users/me/messages', {
          headers: { Authorization: 'Bearer google-oauth-token' },
        }),
      ).rejects.toBeInstanceOf(HttpError)

      expect(dispatchSpy).not.toHaveBeenCalled()
    })

    it('does not dispatch on 401 from external API even when the app accidentally attached its own token', async () => {
      // Defense-in-depth: even if a caller forgot to override Authorization for an external URL,
      // the prefix gate prevents a false positive.
      const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await expect(client.get('https://other.com/data')).rejects.toBeInstanceOf(HttpError)

      expect(dispatchSpy).not.toHaveBeenCalled()
    })

    it('does not dispatch on 401 when no Authorization header was attached', async () => {
      const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
      const client = createAuthenticatedClient('https://api.example.com', () => null, { fetch })

      await expect(client.get('data')).rejects.toBeInstanceOf(HttpError)

      expect(dispatchSpy).not.toHaveBeenCalled()
    })

    it('does not dispatch on non-401 errors', async () => {
      const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Server Error', { status: 500 })))
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await expect(client.get('data')).rejects.toBeInstanceOf(HttpError)

      expect(dispatchSpy).not.toHaveBeenCalled()
    })

    it('does not dispatch on successful responses', async () => {
      const fetch = mockFetch()
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await client.get('data')

      expect(dispatchSpy).not.toHaveBeenCalled()
    })

    it('does not dispatch from anonymous createClient on 401', async () => {
      const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
      const client = createClient({ fetch })

      await expect(client.get('https://example.com/data')).rejects.toBeInstanceOf(HttpError)

      expect(dispatchSpy).not.toHaveBeenCalled()
    })

    it('dispatches when caller passes an absolute URL on the app backend', async () => {
      const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
      const client = createAuthenticatedClient('https://api.example.com', () => 'app-token', { fetch })

      await expect(client.get('https://api.example.com/v1/foo')).rejects.toBeInstanceOf(HttpError)

      expect(dispatchSpy).toHaveBeenCalledTimes(1)
    })

    it('dispatches on a backend 401 when the configured prefix is relative', async () => {
      const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
      const client = createRelativePrefixClient(() => 'app-token', { fetch })

      await expect(client.get('account/devices')).rejects.toBeInstanceOf(HttpError)

      expect(dispatchSpy).toHaveBeenCalledTimes(1)
      const event = dispatchSpy.mock.calls[0][0] as CustomEvent
      expect(event.type).toBe('powersync_credentials_invalid')
      expect(event.detail).toEqual({ reason: 'session_expired' })
    })

    it('does not dispatch on an external 401 sharing a relative backend path', async () => {
      const fetch = mock<FetchFn>(() => Promise.resolve(new Response('Unauthorized', { status: 401 })))
      const client = createRelativePrefixClient(() => 'app-token', { fetch })

      await expect(
        client.get('https://external.example.com/v1/account/devices', {
          headers: { Authorization: 'Bearer external-token' },
        }),
      ).rejects.toBeInstanceOf(HttpError)

      expect(dispatchSpy).not.toHaveBeenCalled()
    })
  })
})

describe('app-version-unsupported detection', () => {
  const originalDispatch = window.dispatchEvent
  let dispatchSpy: ReturnType<typeof mock>

  beforeEach(() => {
    resetAppVersionBlockedForTesting()
    dispatchSpy = mock(() => true)
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
  })

  afterEach(() => {
    window.dispatchEvent = originalDispatch
    // The 426s driven here latch the module-level `versionBlocked` singleton.
    // Leaving it set makes an unrelated file's "not blocked" assertion fail —
    // the classic passes-alone/fails-together flake.
    resetAppVersionBlockedForTesting()
  })

  it('dispatches app_version_unsupported on a backend 426 without reading the response body', async () => {
    const body = new Response('should not be read', { status: 426 })
    const fetch = mock<FetchFn>(() => Promise.resolve(body))
    const client = createAuthenticatedClient('https://api.example.com', () => 'token', { fetch })

    await expect(client.get('https://api.example.com/data')).rejects.toBeInstanceOf(HttpError)

    const event = dispatchSpy.mock.calls.find((call) => (call[0] as CustomEvent).type === appVersionUnsupported)
    expect(event).toBeTruthy()
    // The body stream belongs to the caller — detection must not consume it.
    expect(body.bodyUsed).toBe(false)
  })

  it('does not dispatch app_version_unsupported on other backend error statuses', async () => {
    const fetch = mock<FetchFn>(() => Promise.resolve(new Response(null, { status: 500 })))
    const client = createAuthenticatedClient('https://api.example.com', () => 'token', { fetch })

    await expect(client.get('https://api.example.com/data')).rejects.toBeInstanceOf(HttpError)

    const event = dispatchSpy.mock.calls.find((call) => (call[0] as CustomEvent).type === appVersionUnsupported)
    expect(event).toBeUndefined()
  })

  it('ignores a 426 from an external URL (only app-backend 426 blocks the app)', async () => {
    const fetch = mock<FetchFn>(() => Promise.resolve(new Response(null, { status: 426 })))
    // Bare client used for external APIs — an external 426 must not trip the upgrade blocker.
    const client = createClient({ fetch })

    await expect(client.get('https://external.example.com/data')).rejects.toBeInstanceOf(HttpError)

    const event = dispatchSpy.mock.calls.find((call) => (call[0] as CustomEvent).type === appVersionUnsupported)
    expect(event).toBeUndefined()
  })
})
