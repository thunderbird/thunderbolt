/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { createOpenRouterAuth, type OpenRouterAuthDependencies } from './openrouter-auth'
import { createTinfoilAuth } from './tinfoil-auth'

/** Flushes the injected asynchronous platform boundaries without advancing timers. */
const settle = async () => {
  for (const _ of Array.from({ length: 15 })) {
    await Promise.resolve()
  }
}

/** Captures platform I/O without global mocks or real OAuth requests. */
const createHarness = (native = true, overrides: Partial<OpenRouterAuthDependencies> = {}) => {
  const state = {
    loopbackHandler: null as ((url: string) => void) | null,
    openedUrl: '',
  }
  const requests: Request[] = []
  const removeLoopbackListener = mock(() => {
    state.loopbackHandler = null
  })
  const deps: OpenRouterAuthDependencies = {
    isTauri: () => native,
    isMobile: () => false,
    startLoopback: async () => 17421,
    stopLoopback: async () => {},
    listenForLoopback: async (handler) => {
      state.loopbackHandler = handler
      return removeLoopbackListener
    },
    openExternalUrl: async (url) => {
      expect(state.loopbackHandler).not.toBeNull()
      state.openedUrl = url
    },
    generateVerifier: () => 'secret-verifier',
    generateChallenge: async () => 'hashed-challenge',
    generateState: () => 'expected-nonce',
    fetch: async (input) => {
      requests.push(input as Request)
      return Response.json({ key: 'connected-api-key' })
    },
    timeoutMs: 1000,
    ...overrides,
  }
  return { auth: createOpenRouterAuth(deps), deps, state, requests, removeLoopbackListener }
}

const successfulLoopback = 'http://localhost:17421/?code=authorization-code&state=expected-nonce'

describe('Tinfoil OAuth', () => {
  it('uses standard PKCE parameters and exchanges a form-encoded grant with the exact redirect', async () => {
    const harness = createHarness()
    const auth = createTinfoilAuth('public-client', {
      ...harness.deps,
      fetch: async (input) => {
        harness.requests.push(input as Request)
        return Response.json({
          access_token: 'bearer',
          refresh_token: 'refresh',
          expires_in: 900,
          token_type: 'Bearer',
        })
      },
    })
    const pending = auth.startConnection()
    await settle()
    const url = new URL(harness.state.openedUrl)
    expect(url.origin).toBe('https://dash.tinfoil.sh')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:17421/')
    expect(url.searchParams.get('client_id')).toBe('public-client')
    expect(url.searchParams.get('scope')).toBe('inference:api offline_access')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('callback_url')).toBe(false)
    harness.state.loopbackHandler?.(successfulLoopback)
    expect(await pending).toMatchObject({ access_token: 'bearer', refresh_token: 'refresh' })
    expect(harness.requests[0].url).toBe('https://api.tinfoil.sh/oauth/token')
    expect(harness.requests[0].redirect).toBe('error')
    expect(harness.requests[0].credentials).toBe('omit')
    expect(Object.fromEntries(new URLSearchParams(await harness.requests[0].text()))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'public-client',
      code: 'authorization-code',
      code_verifier: 'secret-verifier',
      redirect_uri: 'http://localhost:17421/',
    })
  })

  it('refreshes and preserves a non-rotated refresh token', async () => {
    const auth = createTinfoilAuth('public-client', {
      fetch: async () => Response.json({ access_token: 'new', expires_in: 900, token_type: 'bearer' }),
    })
    expect(await auth.refresh('old-refresh')).toMatchObject({ access_token: 'new', refresh_token: 'old-refresh' })
  })

  it('rejects malformed successful responses and sanitizes provider failures', async () => {
    const malformed = createTinfoilAuth('public-client', {
      fetch: async () => Response.json({ access_token: 'secret' }),
    })
    await expect(malformed.refresh('refresh')).rejects.toThrow('Could not connect to Tinfoil')
    const rejected = createTinfoilAuth('public-client', {
      fetch: async () => Response.json({ error: 'invalid_grant', error_description: 'secret' }, { status: 400 }),
    })
    await expect(rejected.refresh('refresh')).rejects.toThrow('Reconnect Tinfoil')
  })
})

describe('OpenRouter native connection', () => {
  it('keeps browser authorization in the separate redirect flow', async () => {
    const startLoopback = mock(async () => 17421)
    const harness = createHarness(false, { startLoopback })
    await expect(harness.auth.startConnection()).rejects.toThrow('browser redirect flow')
    expect(startLoopback).not.toHaveBeenCalled()
    expect(harness.state.openedUrl).toBe('')
  })

  it('cancels during PKCE preparation without starting a listener', async () => {
    const controller = new AbortController()
    const startLoopback = mock(async () => 17421)
    const harness = createHarness(true, { generateChallenge: () => new Promise(() => {}), startLoopback })
    const promise = harness.auth.startConnection({ signal: controller.signal })
    controller.abort('private reason')
    await expect(promise).rejects.toMatchObject({ name: 'AbortError', message: 'OpenRouter connection was cancelled.' })
    expect(startLoopback).not.toHaveBeenCalled()
    expect(harness.state.openedUrl).toBe('')
  })

  it('rejects concurrent authorization and allows retry after cancellation', async () => {
    const controller = new AbortController()
    const harness = createHarness()
    const first = harness.auth.startConnection({ signal: controller.signal })
    await expect(harness.auth.startConnection()).rejects.toThrow('already in progress')
    await settle()
    controller.abort()
    await expect(first).rejects.toHaveProperty('name', 'AbortError')
    expect(harness.removeLoopbackListener).toHaveBeenCalledTimes(1)
    const second = harness.auth.startConnection()
    await settle()
    harness.state.loopbackHandler?.(successfulLoopback)
    expect(await second).toBe('connected-api-key')
    expect(harness.removeLoopbackListener).toHaveBeenCalledTimes(2)
  })

  it('opens a loopback authorization and ignores callbacks for other origins or ports', async () => {
    const harness = createHarness(true)
    const promise = harness.auth.startConnection()
    await settle()
    const url = new URL(harness.state.openedUrl)
    expect(url.searchParams.get('callback_url')).toBe('http://localhost:17421/')
    expect(url.searchParams.get('state')).toBe('expected-nonce')
    expect(url.searchParams.get('code_challenge')).toBe('hashed-challenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.toString()).not.toContain('secret-verifier')
    harness.state.loopbackHandler?.('http://localhost:17422/?code=unrelated&state=expected-nonce')
    harness.state.loopbackHandler?.('https://localhost:17421/?code=unrelated&state=expected-nonce')
    harness.state.loopbackHandler?.('invalid-url')
    expect(harness.requests).toHaveLength(0)
    harness.state.loopbackHandler?.(successfulLoopback)
    expect(await promise).toBe('connected-api-key')
    expect(harness.removeLoopbackListener).toHaveBeenCalledTimes(1)
    const request = harness.requests[0]
    expect(request.url).toBe('https://openrouter.ai/api/v1/auth/keys')
    expect(request.method).toBe('POST')
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')
    expect(request.headers.get('Authorization')).toBeNull()
    expect(await request.json()).toEqual({
      code: 'authorization-code',
      code_verifier: 'secret-verifier',
      code_challenge_method: 'S256',
    })
  })

  it.each([
    'http://localhost:17421/?code=authorization-code&state=wrong',
    'http://localhost:17421/?state=expected-nonce',
    'http://localhost:17421/other?code=authorization-code&state=expected-nonce',
    'http://localhost:17421/other?error=access_denied',
    'http://localhost:17421/?code=authorization-code&code=other&state=expected-nonce',
    'http://localhost:17421/?code=authorization-code&state=expected-nonce&state=other',
  ])('rejects invalid local callbacks: %s', async (callback) => {
    const harness = createHarness(true)
    const promise = harness.auth.startConnection()
    await settle()
    harness.state.loopbackHandler?.(callback)
    await expect(promise).rejects.toThrow('invalid authorization response')
    expect(harness.requests).toHaveLength(0)
    expect(harness.removeLoopbackListener).toHaveBeenCalledTimes(1)
  })

  it('sanitizes a native denial without requiring state', async () => {
    const harness = createHarness(true)
    const promise = harness.auth.startConnection()
    await settle()
    harness.state.loopbackHandler?.('http://localhost:17421/?error_description=secret-response')
    await expect(promise).rejects.toThrow('connection was cancelled')
    expect(harness.requests).toHaveLength(0)
  })

  it('cleans up after the system browser fails to open', async () => {
    const harness = createHarness(true, {
      openExternalUrl: async () => {
        throw new Error('secret-provider-response')
      },
    })
    await expect(harness.auth.startConnection()).rejects.toThrow('Could not open')
    expect(harness.removeLoopbackListener).toHaveBeenCalledTimes(1)
  })

  it('cleans up a listener that finishes registering after cancellation', async () => {
    const controller = new AbortController()
    let finishRegister!: (cleanup: () => void) => void
    const registration = new Promise<() => void>((resolve) => {
      finishRegister = resolve
    })
    const removeListener = mock(() => {})
    const harness = createHarness(true, { listenForLoopback: () => registration })
    const promise = harness.auth.startConnection({ signal: controller.signal })
    await settle()
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    finishRegister(removeListener)
    await settle()
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(harness.state.openedUrl).toBe('')
  })

  it('stops a native listener on cancellation, freeing its registered port', async () => {
    const stopLoopback = mock(async (_flowId: string) => {})
    const harness = createHarness(true, { stopLoopback })
    const controller = new AbortController()
    const promise = harness.auth.startConnection({ signal: controller.signal })
    await settle()
    controller.abort()
    await expect(promise).rejects.toHaveProperty('name', 'AbortError')
    expect(stopLoopback).toHaveBeenCalledWith('expected-nonce')
    expect(stopLoopback).toHaveBeenCalledTimes(1)
  })

  it('stops a listener that finishes starting after the flow was cancelled', async () => {
    const pending = Promise.withResolvers<number>()
    const stopLoopback = mock(async (_flowId: string) => {})
    const harness = createHarness(true, { startLoopback: () => pending.promise, stopLoopback })
    const controller = new AbortController()
    const promise = harness.auth.startConnection({ signal: controller.signal })
    await settle()
    controller.abort()
    await expect(promise).rejects.toHaveProperty('name', 'AbortError')
    pending.resolve(17421)
    await settle()
    expect(stopLoopback).toHaveBeenCalledWith('expected-nonce')
  })

  it('uses the manual flow on native mobile without starting a loopback server', async () => {
    const harness = createHarness(true, { isMobile: () => true })
    await expect(harness.auth.startConnection()).rejects.toThrow('authorization code option')
    expect(harness.state.loopbackHandler).toBeNull()
  })

  it('cleans up a native listener when authorization times out', async () => {
    const harness = createHarness(true)
    const result = harness.auth.startConnection().catch((error: unknown) => error)
    await getClock().tickAsync(1000)
    expect(((await result) as Error).message).toContain('timed out')
    expect(harness.removeLoopbackListener).toHaveBeenCalledTimes(1)
    expect(harness.requests).toHaveLength(0)
  })
})

describe('OpenRouter manual authorization and exchange', () => {
  it('returns a headless S256 authorization URL and keeps its verifier out of the URL', async () => {
    const harness = createHarness()
    const result = await harness.auth.prepareManualConnection()
    expect(result.verifier).toBe('secret-verifier')
    expect(Object.fromEntries(new URL(result.authorizationUrl).searchParams)).toEqual({
      code_challenge: 'hashed-challenge',
      code_challenge_method: 'S256',
      key_label: 'Thunderbolt',
    })
    expect(result.authorizationUrl).not.toContain('secret-verifier')
    expect(harness.requests).toHaveLength(0)
  })

  it.each([{ key: '' }, { key: ' ' }, { key: 1 }, {}, null, ['secret-key']])(
    'rejects an invalid API-key response: %j',
    async (body) => {
      const harness = createHarness(false, { fetch: async () => Response.json(body) })
      await expect(harness.auth.exchangeCode('code', 'verifier')).rejects.toThrow('Could not connect')
    },
  )

  it('does not expose provider response details or network errors', async () => {
    const harness = createHarness(false, {
      fetch: async () => {
        throw new Error('secret-verifier connected-api-key')
      },
    })
    await expect(harness.auth.exchangeCode('code', 'verifier')).rejects.toThrow(
      'Could not connect to OpenRouter. Please try again with a new authorization code.',
    )
  })

  it('does not send empty codes or an already cancelled exchange', async () => {
    const harness = createHarness()
    await expect(harness.auth.exchangeCode(' ', 'verifier')).rejects.toThrow('invalid authorization response')
    const controller = new AbortController()
    controller.abort()
    await expect(harness.auth.exchangeCode('code', 'verifier', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(harness.requests).toHaveLength(0)
  })

  it('forwards cancellation to the native-aware exchange transport', async () => {
    const controller = new AbortController()
    const requestSignals: AbortSignal[] = []
    const harness = createHarness(false, {
      fetch: async (input) => {
        const request = input as Request
        requestSignals.push(request.signal)
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('private transport details')), {
            once: true,
          })
        })
      },
    })
    const promise = harness.auth.exchangeCode('code', 'verifier', controller.signal)
    await settle()
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestSignals).toHaveLength(1)
    expect(requestSignals[0].aborted).toBe(true)
  })
})

/** A transport that returns headers but stalls the JSON body until the request is cancelled. */
const stalledTokenTransport = () => {
  const signals: AbortSignal[] = []
  const fetch: OpenRouterAuthDependencies['fetch'] = async (input) => {
    const request = input as Request
    signals.push(request.signal)
    return new Response(
      new ReadableStream({
        start(controller) {
          request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true })
        },
      }),
    )
  }
  return { fetch, signals }
}

it.each(['openrouter', 'tinfoil'] as const)(
  'times out stalled %s token bodies after headers arrive',
  async (provider) => {
    // Bun's native AbortSignal.timeout is outside the fake clock; control that boundary explicitly.
    const deadline = new AbortController()
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const transport = stalledTokenTransport()
    try {
      const result = (
        provider === 'openrouter'
          ? createOpenRouterAuth({ fetch: transport.fetch }).exchangeCode('code', 'verifier')
          : createTinfoilAuth('client', { fetch: transport.fetch }).refresh('refresh')
      ).catch((error: unknown) => error)
      await settle()
      expect(timeout).toHaveBeenCalledWith(30_000)
      expect(transport.signals[0].aborted).toBe(false)
      deadline.abort(new DOMException('Token request timed out', 'TimeoutError'))
      expect(await result).toBeInstanceOf(Error)
      expect(((await result) as Error).message).toContain('Could not connect')
      expect(transport.signals[0].reason.name).toBe('TimeoutError')
    } finally {
      timeout.mockRestore()
    }
  },
)

it.each(['openrouter', 'tinfoil'] as const)(
  'cancels a stalled %s token body on user cancellation',
  async (provider) => {
    const transport = stalledTokenTransport()
    const controller = new AbortController()
    const harness = createHarness(true, { fetch: transport.fetch })
    const auth = provider === 'openrouter' ? harness.auth : createTinfoilAuth('client', harness.deps)
    const result = auth.startConnection({ signal: controller.signal }).catch((error: unknown) => error)
    await settle()
    harness.state.loopbackHandler?.(successfulLoopback)
    await settle()
    controller.abort()
    expect(await result).toHaveProperty('name', 'AbortError')
    expect(transport.signals[0].aborted).toBe(true)
  },
)

it('refuses redirect replay for Tinfoil refresh and revocation credentials', async () => {
  const requests: Request[] = []
  const auth = createTinfoilAuth('client', {
    fetch: async (input) => {
      const request = input as Request
      requests.push(request)
      return request.url.endsWith('/revoke')
        ? new Response(null, { status: 204 })
        : Response.json({ access_token: 'new', expires_in: 900, token_type: 'bearer' })
    },
  })
  await auth.refresh('refresh')
  await auth.revoke('refresh')
  expect(requests.map((request) => request.redirect)).toEqual(['error', 'error'])
  expect(requests.map((request) => request.credentials)).toEqual(['omit', 'omit'])
})
