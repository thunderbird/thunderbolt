/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { getClock } from '@/testing-library'
import { mobileOAuthRedirectUri } from '@/lib/oauth-redirect'
import {
  captureOtariBrowserReturn,
  captureOtariMobileReturn,
  clearOtariBrowserReturn,
  getOtariBrowserReturn,
  getOtariBrowserDraft,
  discardOtariBrowserDraft,
  startOtariBrowserConnection,
} from './otari-browser-auth'

const nonce = 'n'.repeat(43)
const verifier = 'v'.repeat(43)
const key = 'thunderbolt.otari.authorization'
const attempt = { provider: 'otari' as const, revision: 'saved-session-revision' }
const currentUrl = new URL('https://app.test/chats/new')

/** Isolate the tab store and navigation while using real PKCE and response validation. */
const setup = () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value)
    },
    removeItem: (name: string) => {
      values.delete(name)
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
  const navigate = mock((_url: string) => {})
  const exchange = mock(
    async (_origin: string, _grant: { code: string; verifier: string; redirectUri: string }, _signal: AbortSignal) =>
      'delegated-key',
  )
  const random = mock(() => nonce).mockImplementationOnce(() => verifier)
  return {
    storage,
    navigate,
    exchange,
    deps: {
      storage: () => storage,
      currentUrl: () => currentUrl,
      navigate,
      verifier: random,
      now: () => 1_000,
      exchange,
    },
  }
}
const callback = (query = `code=one-use&state=${nonce}`) => new URL(`https://app.test/oauth/otari?${query}`)
afterEach(() => {
  clearOtariBrowserReturn(nonce)
  localStorage.removeItem(key)
  mock.restore()
})

describe('Otari same-tab authorization', () => {
  test('returns to the Connections page and restores its owning context', async () => {
    const { deps } = setup()
    const page = { ...deps, currentUrl: () => new URL('https://app.test/settings/connections') }
    await startOtariBrowserConnection(
      'http://localhost:8099',
      'connections',
      new AbortController().signal,
      attempt,
      page,
    )
    const returned = captureOtariBrowserReturn(callback(), page)!
    expect(returned.context).toBe('connections')
    expect(returned.returnTo).toBe('/settings/connections')
    expect(await returned.complete()).toBe('delegated-key')
  })
  test('navigates this tab with S256, stores only temporary request state, and restores the selected server', async () => {
    const { deps, storage, navigate, exchange } = setup()
    await startOtariBrowserConnection(
      'http://localhost:8099',
      'onboarding',
      new AbortController().signal,
      attempt,
      deps,
    )
    const url = new URL(navigate.mock.calls[0][0])
    const params = url.searchParams
    expect(url.origin).toBe('http://localhost:8099')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toHaveLength(43)
    expect(params.get('redirect_uri')).toBe('https://app.test/oauth/otari')
    expect(params.get('state')).toBe(nonce)
    expect(url.href).not.toContain(verifier)
    const result = captureOtariBrowserReturn(callback(), deps)!
    expect(result.returnTo).toBe('/chats/new')
    expect(result.origin).toBe('http://localhost:8099')
    expect(result.context).toBe('onboarding')
    expect(result.attempt).toEqual(attempt)
    expect(storage.length).toBe(0)
    expect(await result.complete()).toBe('delegated-key')
    expect(exchange).toHaveBeenCalledWith(
      'http://localhost:8099',
      { code: 'one-use', verifier, redirectUri: 'https://app.test/oauth/otari' },
      expect.any(AbortSignal),
    )
    expect(storage.length).toBe(0)
  })

  test('consumes and exchanges only once across repeated callback mounts', async () => {
    const { deps, exchange } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
    const first = captureOtariBrowserReturn(callback(), deps)!
    const second = captureOtariBrowserReturn(callback(), deps)!
    expect(first).toBe(second)
    expect(await Promise.all([first.complete(), second.complete()])).toEqual(['delegated-key', 'delegated-key'])
    expect(exchange).toHaveBeenCalledTimes(1)
    clearOtariBrowserReturn(first.id)
    expect(captureOtariBrowserReturn(callback(), deps)).toBeNull()
  })

  test.each(['code=code&state=wrong', `code=code&state=${nonce}&state=duplicate`])(
    'rejects an unbound callback: %s',
    async (query) => {
      const { deps, exchange } = setup()
      await startOtariBrowserConnection('https://otari.ai', 'onboarding', new AbortController().signal, attempt, deps)
      expect(captureOtariBrowserReturn(callback(query), deps)).toBeNull()
      expect(exchange).not.toHaveBeenCalled()
    },
  )

  test('returns a sanitized cancellation to setup, without exchanging a code', async () => {
    const { deps, storage, exchange } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'onboarding', new AbortController().signal, attempt, deps)
    const result = captureOtariBrowserReturn(
      callback(`error=access_denied&error_description=private-detail&state=${nonce}`),
      deps,
    )!
    await expect(result.complete()).rejects.toThrow('Connection cancelled')
    expect(result.error).not.toContain('private-detail')
    expect(exchange).not.toHaveBeenCalled()
    expect(storage.length).toBe(0)
  })

  test('expires the saved request instead of exchanging it', async () => {
    const { deps, exchange } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'onboarding', new AbortController().signal, attempt, deps)
    const result = captureOtariBrowserReturn(callback(), { ...deps, now: () => 601_001 })!
    await expect(result.complete()).rejects.toThrow('expired')
    expect(exchange).not.toHaveBeenCalled()
  })

  test.each(['server_error', 'invalid_request', ''])(
    'does not describe a provider failure as user cancellation: %s',
    async (error) => {
      const { deps, exchange } = setup()
      await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
      const result = captureOtariBrowserReturn(
        callback(`error=${error}&error_description=private-detail&state=${nonce}`),
        deps,
      )!
      await expect(result.complete()).rejects.toThrow('invalid response')
      expect(result.error).not.toContain('private-detail')
      expect(exchange).not.toHaveBeenCalled()
    },
  )

  test.each([`state=${nonce}`, `code=%20&state=${nonce}`, `code=one&code=two&state=${nonce}`])(
    'rejects malformed success responses: %s',
    async (query) => {
      const { deps, storage, exchange } = setup()
      await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
      const result = captureOtariBrowserReturn(callback(query), deps)!
      await expect(result.complete()).rejects.toThrow('invalid response')
      expect(storage.length).toBe(0)
      expect(exchange).not.toHaveBeenCalled()
    },
  )

  test.each([-1, 600_001])('rejects a request age outside its lifetime: %s', async (age) => {
    const { deps, exchange } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
    const result = captureOtariBrowserReturn(callback(), { ...deps, now: () => 1_000 + age })!
    await expect(result.complete()).rejects.toThrow('expired')
    expect(exchange).not.toHaveBeenCalled()
  })

  test('accepts the expiration boundary and preserves a local query and fragment', async () => {
    const { deps } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, {
      ...deps,
      currentUrl: () => new URL('https://app.test/settings/models?add=otari#picker'),
    })
    const result = captureOtariBrowserReturn(callback(), { ...deps, now: () => 601_000 })!
    expect(result.returnTo).toBe('/settings/models?add=otari#picker')
    expect(await result.complete()).toBe('delegated-key')
  })

  test.each([
    { origin: 'http://remote.example' },
    { redirectUri: 'https://other-app.test/oauth/otari' },
    { verifier: 'invalid-pkce' },
    { attempt: undefined },
    { attempt: { provider: 'openrouter', revision: 'wrong-provider' } },
  ])('rejects tampered request metadata: %j', async (changes) => {
    const { deps, storage, exchange } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
    storage.setItem(key, JSON.stringify({ ...JSON.parse(storage.getItem(key)!), ...changes }))
    expect(captureOtariBrowserReturn(callback(), deps)).toBeNull()
    expect(exchange).not.toHaveBeenCalled()
  })

  test('does not consume the pending request from another callback path or state', async () => {
    const { deps, storage } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
    expect(captureOtariBrowserReturn(new URL(`https://app.test/oauth/other?code=code&state=${nonce}`), deps)).toBeNull()
    expect(captureOtariBrowserReturn(callback('code=code&state=unrelated'), deps)).toBeNull()
    expect(storage.length).toBe(1)
    expect(await captureOtariBrowserReturn(callback(), deps)!.complete()).toBe('delegated-key')
  })

  test.each(['https://evil.example', '//evil.example', '/\\evil.example', '/oauth/otari'])(
    'rejects a modified return destination: %s',
    async (returnTo) => {
      const { deps, storage, exchange } = setup()
      await startOtariBrowserConnection('https://otari.ai', 'onboarding', new AbortController().signal, attempt, deps)
      storage.setItem(key, JSON.stringify({ ...JSON.parse(storage.getItem(key)!), returnTo }))
      expect(captureOtariBrowserReturn(callback(), deps)).toBeNull()
      expect(exchange).not.toHaveBeenCalled()
    },
  )

  test('restores the same setup and server on Back without reauthorizing', async () => {
    const { deps, storage, exchange } = setup()
    await startOtariBrowserConnection(
      'http://localhost:8099',
      'onboarding',
      new AbortController().signal,
      attempt,
      deps,
    )
    expect(getOtariBrowserDraft('models', deps)).toBeNull()
    expect(
      getOtariBrowserDraft('onboarding', { ...deps, currentUrl: () => new URL('https://app.test/settings/models') }),
    ).toBeNull()
    expect(getOtariBrowserDraft('onboarding', { ...deps, now: () => 601_001 })).toBeNull()
    expect(getOtariBrowserDraft('onboarding', deps)).toEqual({ id: nonce, origin: 'http://localhost:8099' })
    discardOtariBrowserDraft('different-request', storage)
    expect(storage.length).toBe(1)
    discardOtariBrowserDraft(nonce, storage)
    expect(storage.length).toBe(0)
    expect(exchange).not.toHaveBeenCalled()
  })

  test('does not restore a draft whose callback belongs to another application origin', async () => {
    const { deps } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
    expect(
      getOtariBrowserDraft('models', {
        ...deps,
        currentUrl: () => new URL('https://other-app.test/chats/new'),
      }),
    ).toBeNull()
  })

  test('does not start another authorization from a callback screen', async () => {
    const { deps, storage, navigate } = setup()
    await expect(
      startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, {
        ...deps,
        currentUrl: () => callback(),
      }),
    ).rejects.toThrow('Invalid Otari return path')
    expect(storage.length).toBe(0)
    expect(navigate).not.toHaveBeenCalled()
  })

  test('tolerates a corrupted draft without starting an exchange', () => {
    const { deps, storage, exchange } = setup()
    storage.setItem(key, '{')
    expect(getOtariBrowserDraft('onboarding', deps)).toBeNull()
    expect(() => discardOtariBrowserDraft(nonce, storage)).not.toThrow()
    expect(captureOtariBrowserReturn(callback(), deps)).toBeNull()
    expect(exchange).not.toHaveBeenCalled()
  })

  test('does not navigate or retain state if preparation is cancelled', async () => {
    const { deps, storage, navigate } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(
      startOtariBrowserConnection('https://otari.ai', 'onboarding', controller.signal, attempt, deps),
    ).rejects.toThrow()
    expect(navigate).not.toHaveBeenCalled()
    expect(storage.length).toBe(0)
  })

  test('does not navigate if cancellation happens while hashing the verifier', async () => {
    const { deps, storage, navigate } = setup()
    const controller = new AbortController()
    const challenge = Promise.withResolvers<string>()
    const pending = startOtariBrowserConnection('https://otari.ai', 'models', controller.signal, attempt, {
      ...deps,
      challenge: () => challenge.promise,
    })
    controller.abort()
    challenge.resolve('hashed-verifier')
    await expect(pending).rejects.toHaveProperty('name', 'AbortError')
    expect(storage.length).toBe(0)
    expect(navigate).not.toHaveBeenCalled()
  })

  test('removes request state if navigation fails', async () => {
    const { deps, storage } = setup()
    await expect(
      startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, {
        ...deps,
        navigate: () => {
          throw new Error('Navigation denied')
        },
      }),
    ).rejects.toThrow('Navigation denied')
    expect(storage.length).toBe(0)
  })

  test('cannot start without tab storage and treats unavailable return storage as an invalid link', async () => {
    const { deps, navigate, exchange } = setup()
    const blocked = {
      ...deps,
      storage: (): Storage => {
        throw new DOMException('Blocked', 'SecurityError')
      },
    }
    await expect(
      startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, blocked),
    ).rejects.toThrow('Blocked')
    expect(navigate).not.toHaveBeenCalled()
    expect(getOtariBrowserDraft('models', blocked)).toBeNull()
    expect(captureOtariBrowserReturn(callback(), blocked)).toBeNull()
    expect(exchange).not.toHaveBeenCalled()
  })

  test('can cancel before the first exchange without sending the grant', async () => {
    const { deps, exchange } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
    const result = captureOtariBrowserReturn(callback(), deps)!
    result.cancel()
    await expect(result.complete()).rejects.toHaveProperty('name', 'AbortError')
    expect(exchange).not.toHaveBeenCalled()
  })

  test('does not replay a one-use code after a failed exchange', async () => {
    const { deps } = setup()
    const exchange = mock(async () => {
      throw new Error('Exchange failed')
    })
    await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
    const result = captureOtariBrowserReturn(callback(), { ...deps, exchange })!
    await expect(result.complete()).rejects.toThrow('Exchange failed')
    await expect(result.complete()).rejects.toThrow('Exchange failed')
    expect(exchange).toHaveBeenCalledTimes(1)
    clearOtariBrowserReturn('different-request')
    expect(getOtariBrowserReturn('models')).toBe(result)
  })

  test('can cancel a pending exchange and clears the handoff on consumption', async () => {
    const { deps, exchange } = setup()
    await startOtariBrowserConnection('https://otari.ai', 'models', new AbortController().signal, attempt, deps)
    const result = captureOtariBrowserReturn(callback(), deps)!
    await result.complete()
    result.cancel()
    expect(exchange.mock.calls[0][2].aborted).toBe(true)
    expect(getOtariBrowserReturn('onboarding')).toBeNull()
    expect(getOtariBrowserReturn('models')).toBe(result)
    clearOtariBrowserReturn(result.id)
    expect(getOtariBrowserReturn('models')).toBeNull()
  })
})

describe('Otari native mobile authorization', () => {
  /** Model a native WebView while isolating the external browser and durable storage. */
  const mobileSetup = () => {
    const harness = setup()
    const deps = {
      ...harness.deps,
      mobile: () => true,
      currentUrl: () => new URL('tauri://localhost/settings/models'),
      challenge: async () => 'hashed-verifier',
      now: Date.now,
    }
    const controller = new AbortController()
    const pending = startOtariBrowserConnection('https://otari.ai', 'models', controller.signal, attempt, deps).catch(
      (error: unknown) => error,
    )
    return { ...harness, deps, controller, pending }
  }

  test('uses the Google/Microsoft verified app link and resumes from the same pending grant', async () => {
    const harness = mobileSetup()
    await getClock().tickAsync(0)
    const authorization = new URL(harness.navigate.mock.calls[0][0])
    expect(authorization.searchParams.get('redirect_uri')).toBe(mobileOAuthRedirectUri)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(harness.storage.length).toBe(1)
    expect(getOtariBrowserDraft('models', harness.deps)).toBeNull()
    const returned = captureOtariBrowserReturn(
      new URL(`${mobileOAuthRedirectUri}?code=one-use&state=${nonce}`),
      harness.deps,
    )!
    expect(returned.returnTo).toBe('/settings/models')
    expect(returned.attempt).toEqual(attempt)
    // Navigation to the callback unmounts the old owner without cancelling its new handoff.
    harness.controller.abort()
    expect(await harness.pending).toHaveProperty('name', 'AbortError')
    expect(await returned.complete()).toBe('delegated-key')
    expect(harness.exchange.mock.calls[0][1].redirectUri).toBe(mobileOAuthRedirectUri)
    expect(harness.storage.length).toBe(0)
  })

  test('recovers the persisted PKCE request after the app process is terminated', async () => {
    const harness = mobileSetup()
    await getClock().tickAsync(0)
    const persisted = harness.storage.getItem(key)!
    harness.controller.abort()
    await harness.pending
    // A restarted process has only durable storage, not the original owner or promise.
    localStorage.setItem(key, persisted)
    const returned = captureOtariMobileReturn(new URL(`${mobileOAuthRedirectUri}?code=one-use&state=${nonce}`))!
    expect(returned).toMatchObject({ id: nonce, context: 'models', attempt, returnTo: '/settings/models', error: '' })
    expect(localStorage.getItem(key)).toBeNull()
    returned.cancel()
    await expect(returned.complete()).rejects.toHaveProperty('name', 'AbortError')
  })

  test.each([
    'http://app.thunderbolt.io/oauth/callback',
    'https://app.thunderbolt.io.evil.test/oauth/callback',
    'https://app.thunderbolt.io:444/oauth/callback',
    'https://app.thunderbolt.io/oauth/callback/extra',
    'https://app.thunderbolt.io/oauth/otari',
  ])('ignores an unregistered app link without consuming the pending grant: %s', async (redirect) => {
    const harness = mobileSetup()
    await getClock().tickAsync(0)
    expect(captureOtariBrowserReturn(new URL(`${redirect}?code=one-use&state=${nonce}`), harness.deps)).toBeNull()
    expect(harness.storage.length).toBe(1)
    harness.controller.abort()
    await harness.pending
  })

  test('keeps a Google or Microsoft callback from consuming Otari state', async () => {
    const harness = mobileSetup()
    await getClock().tickAsync(0)
    expect(
      captureOtariBrowserReturn(new URL(`${mobileOAuthRedirectUri}?code=other&state=google-nonce`), harness.deps),
    ).toBeNull()
    expect(harness.storage.length).toBe(1)
    harness.controller.abort()
    await harness.pending
  })

  test('cancels and clears mobile authorization while the browser is open', async () => {
    const harness = mobileSetup()
    await getClock().tickAsync(0)
    harness.controller.abort()
    expect(await harness.pending).toHaveProperty('name', 'AbortError')
    expect(harness.storage.length).toBe(0)
    expect(
      captureOtariBrowserReturn(new URL(`${mobileOAuthRedirectUri}?code=late&state=${nonce}`), harness.deps),
    ).toBeNull()
    expect(harness.exchange).not.toHaveBeenCalled()
  })

  test('expires an abandoned external-browser flow and removes its verifier', async () => {
    const deadline = new AbortController()
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const harness = mobileSetup()
    await getClock().tickAsync(0)
    expect(timeout).toHaveBeenCalledWith(600_000)
    deadline.abort(new DOMException('Expired', 'TimeoutError'))
    expect(await harness.pending).toHaveProperty('name', 'TimeoutError')
    expect(harness.storage.length).toBe(0)
  })

  test('fails promptly on cancellation even if the native browser launcher is still pending', async () => {
    const { deps, storage } = setup()
    const controller = new AbortController()
    const launch = Promise.withResolvers<void>()
    const pending = startOtariBrowserConnection('https://otari.ai', 'models', controller.signal, attempt, {
      ...deps,
      mobile: () => true,
      challenge: async () => 'challenge',
      navigate: () => launch.promise,
    }).catch((error: unknown) => error)
    await getClock().tickAsync(0)
    controller.abort()
    expect(await pending).toHaveProperty('name', 'AbortError')
    expect(storage.length).toBe(0)
    launch.resolve()
  })
})
