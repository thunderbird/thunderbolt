/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { getClock } from '@/testing-library'
import { i18n } from '@/i18n'
import type { OpenRouterAuthDependencies } from './openrouter-auth'
import {
  connectOtari,
  defaultOtariOrigin,
  exchangeOtariCode,
  getOtariAuthorizationUrl,
  getOtariEndpoints,
  getOtariAuthorizationOrigin,
  normalizeOtariOrigin,
  revokeOtariToken,
} from './otari-auth'

const grant = { code: 'one-use-code', verifier: 'secret-verifier', redirectUri: 'https://app.test/oauth/otari' }
afterEach(() => mock.restore())

/** Drive the real shared native authorization transport through an owned loopback listener. */
const nativeAuthorization = (response = 'code=one-use-code&state=nonce') => {
  const state = { callback: (_url: string) => {}, authorizationUrl: '' }
  const stop = mock(async () => {})
  const unlisten = mock(() => {})
  const dependencies: Partial<OpenRouterAuthDependencies> = {
    isTauri: () => true,
    isMobile: () => false,
    startLoopback: async () => 17421,
    stopLoopback: stop,
    listenForLoopback: async (callback) => {
      state.callback = callback
      return unlisten
    },
    openExternalUrl: async (url) => {
      state.authorizationUrl = url
      state.callback(`http://localhost:17421/?${response}`)
    },
    generateVerifier: () => grant.verifier,
    generateChallenge: async () => 'challenge',
    generateState: () => 'nonce',
  }
  return { dependencies, state, stop, unlisten }
}

describe('Otari authorization boundary', () => {
  test.each([
    [undefined, defaultOtariOrigin],
    ['https://api.otari.ai/api/v1', defaultOtariOrigin],
    [' https://api.otari.ai/api/v1/ ', defaultOtariOrigin],
    ['https://api.otari.ai/', defaultOtariOrigin],
    ['https://OTARI.AI:443/', defaultOtariOrigin],
    ['http://localhost:8099/api/v1', 'http://localhost:8099'],
    ['http://localhost:8099/api/v1///', 'http://localhost:8099'],
    ['https://otari.example', 'https://otari.example'],
  ])('uses the authorization origin for %s', (value, expected) => {
    expect(getOtariAuthorizationOrigin(value)).toBe(expected!)
  })
  test.each(['https://example.com/other', 'https://user@example.com/api/v1', 'http://remote.example/api/v1'])(
    'rejects an unsafe stored endpoint: %s',
    (value) => {
      expect(() => getOtariAuthorizationOrigin(value)).toThrow()
    },
  )
  test('uses the hosted dashboard and separate inference service by default', () => {
    expect(getOtariEndpoints(defaultOtariOrigin)).toEqual({
      dashboard: 'https://otari.ai/dashboard/',
      api: 'https://otari.ai/api/v1',
      inference: 'https://api.otari.ai/api/v1',
    })
    expect(getOtariEndpoints('http://localhost:8099/')).toEqual({
      dashboard: 'http://localhost:8099/',
      api: 'http://localhost:8099/api/v1',
      inference: 'http://localhost:8099/api/v1',
    })
  })
  test('accepts secure origins and loopback development', () => {
    expect(normalizeOtariOrigin('https://otari.example/')).toBe('https://otari.example')
    expect(normalizeOtariOrigin('http://localhost:8099')).toBe('http://localhost:8099')
    expect(normalizeOtariOrigin('http://127.0.0.1:8099')).toBe('http://127.0.0.1:8099')
    expect(normalizeOtariOrigin('http://[::1]:8099')).toBe('http://[::1]:8099')
    expect(normalizeOtariOrigin('https://OTARI.AI:443/')).toBe(defaultOtariOrigin)
  })
  test.each([
    'http://remote.example',
    'https://user:secret@example.com',
    'https://example.com/api',
    'https://example.com?token=secret',
    'https://example.com#fragment',
    'http://localhost.evil.example',
    'javascript:alert(1)',
  ])('refuses unsafe origins: %s', (value) => {
    expect(() => normalizeOtariOrigin(value)).toThrow()
  })
  test.each(['https://app.test/oauth/otari', 'http://localhost:17421/'])(
    'builds the same authorization request for redirect %s',
    (redirectUri) => {
      const url = new URL(
        getOtariAuthorizationUrl(defaultOtariOrigin, { challenge: 'challenge', redirectUri, state: 'nonce' }),
      )
      expect(url.origin + url.pathname).toBe('https://otari.ai/api/v1/oauth/apps/authorize')
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: 'thunderbolt',
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        state: 'nonce',
      })
    },
  )
})

describe('Otari native authorization', () => {
  test.each(['', 'https://attacker.example', 'https://api.otari.ai', 'https://otari.ai&iss=https://otari.ai'])(
    'rejects a different or repeated issuer without sending the code: %s',
    async (issuer) => {
      const harness = nativeAuthorization(`code=one-use-code&state=nonce&iss=${issuer}`)
      const transport = spyOn(globalThis, 'fetch')
      await expect(
        connectOtari(defaultOtariOrigin, new AbortController().signal, harness.dependencies),
      ).rejects.toThrow('Could not connect to Otari')
      expect(transport).not.toHaveBeenCalled()
    },
  )
  test('accepts the exact authorization issuer', async () => {
    const harness = nativeAuthorization('code=one-use-code&state=nonce&iss=https://otari.ai')
    spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ access_token: 'delegated-key' }))
    expect(await connectOtari(defaultOtariOrigin, new AbortController().signal, harness.dependencies)).toBe(
      'delegated-key',
    )
  })
  test('revokes a native token issued just before cancellation reaches its caller', async () => {
    const controller = new AbortController()
    const response = Response.json({ access_token: 'unused-token' })
    const read = response.json.bind(response)
    spyOn(response, 'json').mockImplementation(async () => {
      const body: unknown = await read()
      controller.abort()
      return body
    })
    const transport = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (request: RequestInfo | URL) =>
          (request as Request).url.endsWith('/token') ? response : new Response(null, { status: 200 }),
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
    await expect(
      connectOtari(defaultOtariOrigin, controller.signal, nativeAuthorization().dependencies),
    ).rejects.toHaveProperty('name', 'AbortError')
    expect(transport).toHaveBeenCalledTimes(2)
    const revoke = transport.mock.calls[1][0] as Request
    expect(revoke.url).toBe('https://otari.ai/api/v1/oauth/apps/revoke')
    expect(new URLSearchParams(await revoke.text()).get('token')).toBe('unused-token')
    expect(revoke.signal.aborted).toBe(false)
  })
  test('exchanges the grant with the exact loopback redirect and releases its listener', async () => {
    const harness = nativeAuthorization()
    const transport = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ access_token: 'delegated-key' }))
    expect(await connectOtari(defaultOtariOrigin, new AbortController().signal, harness.dependencies)).toBe(
      'delegated-key',
    )
    const params = new URL(harness.state.authorizationUrl).searchParams
    expect(params.get('redirect_uri')).toBe('http://localhost:17421/')
    expect(params.get('code_challenge')).toBe('challenge')
    expect(params.get('state')).toBe('nonce')
    expect(Object.fromEntries(new URLSearchParams(await (transport.mock.calls[0][0] as Request).text()))).toMatchObject(
      {
        redirect_uri: 'http://localhost:17421/',
        code: grant.code,
        code_verifier: grant.verifier,
      },
    )
    expect(harness.unlisten).toHaveBeenCalledTimes(1)
    expect(harness.stop).toHaveBeenCalledWith('nonce')
  })

  test('sanitizes native callback errors without exchanging a token', async () => {
    const harness = nativeAuthorization('error=access_denied&error_description=private-detail&state=nonce')
    const transport = spyOn(globalThis, 'fetch')
    await expect(connectOtari(defaultOtariOrigin, new AbortController().signal, harness.dependencies)).rejects.toThrow(
      'Could not connect to Otari. Please try again.',
    )
    expect(transport).not.toHaveBeenCalled()
    expect(harness.unlisten).toHaveBeenCalledTimes(1)
  })

  test('keeps sanitized transport errors English under another UI locale', async () => {
    const harness = nativeAuthorization()
    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-transport-detail'))
    const previousLocale = i18n.locale
    try {
      i18n.loadAndActivate({
        locale: 'de',
        messages: { 'Could not connect to Otari. Please try again.': 'Verbindung fehlgeschlagen.' },
      })
      await expect(
        connectOtari(defaultOtariOrigin, new AbortController().signal, harness.dependencies),
      ).rejects.toThrow('Could not connect to Otari. Please try again.')
    } finally {
      i18n.activate(previousLocale)
    }
  })

  test('sanitizes token transport errors and preserves cancellation', async () => {
    const harness = nativeAuthorization()
    spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private-transport-detail'))
    await expect(connectOtari(defaultOtariOrigin, new AbortController().signal, harness.dependencies)).rejects.toThrow(
      'Could not connect to Otari. Please try again.',
    )
    const controller = new AbortController()
    controller.abort()
    await expect(connectOtari(defaultOtariOrigin, controller.signal, harness.dependencies)).rejects.toHaveProperty(
      'name',
      'AbortError',
    )
  })
})

describe('Otari token revocation', () => {
  test('posts only the token with an independent deadline, no cookies, and no redirect replay', async () => {
    const transport = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    await revokeOtariToken('http://localhost:8099', 'delegated-key')
    const request = transport.mock.calls[0][0] as Request
    expect(request.url).toBe('http://localhost:8099/api/v1/oauth/apps/revoke')
    expect(request.method).toBe('POST')
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')
    expect(request.headers.get('Authorization')).toBeNull()
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      token: 'delegated-key',
      token_type_hint: 'access_token',
    })
    expect(request.signal).toBeInstanceOf(AbortSignal)
  })
  test('does not treat an unavailable endpoint as successful revocation', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
    await expect(revokeOtariToken(defaultOtariOrigin, 'delegated-key')).rejects.toThrow()
  })
})

describe('Otari token exchange', () => {
  test('sends only the grant to the selected server, with no cookies or redirect replay', async () => {
    const transport = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ access_token: 'delegated-key' }))
    expect(await exchangeOtariCode('http://localhost:8099', grant, new AbortController().signal)).toBe('delegated-key')
    const request = transport.mock.calls[0][0] as Request
    expect(request.url).toBe('http://localhost:8099/api/v1/oauth/apps/token')
    expect(request.method).toBe('POST')
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')
    expect(request.headers.get('Authorization')).toBeNull()
    expect(request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      client_id: 'thunderbolt',
      grant_type: 'authorization_code',
      code: grant.code,
      code_verifier: grant.verifier,
      redirect_uri: grant.redirectUri,
    })
  })

  test.each(
    [null, {}, [], { access_token: '' }, { access_token: '  ' }, { access_token: 123 }].map((body) => ({ body })),
  )('rejects a malformed token response: %j', async ({ body }) => {
    spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))
    await expect(exchangeOtariCode(defaultOtariOrigin, grant, new AbortController().signal)).rejects.toThrow(
      'Invalid Otari token response',
    )
  })

  test('does not send a cancelled grant', async () => {
    const transport = spyOn(globalThis, 'fetch')
    const controller = new AbortController()
    controller.abort()
    await expect(exchangeOtariCode(defaultOtariOrigin, grant, controller.signal)).rejects.toHaveProperty(
      'name',
      'AbortError',
    )
    expect(transport).not.toHaveBeenCalled()
  })

  test.each(['cancel', 'timeout'] as const)('aborts a stalled token body on %s', async (reason) => {
    const controller = new AbortController()
    const deadline = new AbortController()
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const stalledFetch = async (input: RequestInfo | URL) => {
      const request = input as Request
      return new Response(
        new ReadableStream({
          start(stream) {
            request.signal.addEventListener('abort', () => stream.error(request.signal.reason), { once: true })
          },
        }),
      )
    }
    stalledFetch.preconnect = globalThis.fetch.preconnect
    const transport = spyOn(globalThis, 'fetch').mockImplementation(stalledFetch)
    try {
      const pending = exchangeOtariCode(defaultOtariOrigin, grant, controller.signal)
      await getClock().tickAsync(0)
      expect(timeout).toHaveBeenCalledWith(30_000)
      expect((transport.mock.calls[0][0] as Request).signal.aborted).toBe(false)
      if (reason === 'cancel') {
        controller.abort()
      } else {
        deadline.abort(new DOMException('Timed out', 'TimeoutError'))
      }
      await expect(pending).rejects.toHaveProperty('name', reason === 'cancel' ? 'AbortError' : 'TimeoutError')
      expect((transport.mock.calls[0][0] as Request).signal.aborted).toBe(true)
    } finally {
      timeout.mockRestore()
    }
  })
})
