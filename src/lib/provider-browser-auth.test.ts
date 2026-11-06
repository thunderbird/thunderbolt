/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import {
  startProviderBrowserConnection,
  captureProviderBrowserReturn,
  getProviderBrowserReturn,
  clearProviderBrowserReturn,
} from './provider-browser-auth'

const state = 's'.repeat(43)
const deps = () => ({
  origin: () => 'https://app.example',
  currentPath: () => '/settings/connections' as const,
  storage: () => sessionStorage,
  verifier: () => state,
  challenge: async () => 'challenge',
  navigate: mock((_url: string) => {}),
  now: () => 1000,
  exchangeTinfoil: mock(async () => ({ access_token: 'token', expires_at: 999999 })),
  exchangeOpenRouter: mock(async () => 'key'),
})
afterEach(() => {
  mock.restore()
  sessionStorage.removeItem('thunderbolt.provider.browser-authorization')
  const current = getProviderBrowserReturn()
  if (current) {
    clearProviderBrowserReturn(current.id)
  }
})
it.each(['getItem', 'removeItem'] as const)(
  'rejects storage %s failure without starting a code exchange',
  async (method) => {
    const dependencies = deps()
    await startProviderBrowserConnection(
      'tinfoil',
      'connections',
      { provider: 'tinfoil', revision: '1' },
      new AbortController().signal,
      dependencies,
    )
    const storage: Storage = {
      length: sessionStorage.length,
      getItem: (key) => sessionStorage.getItem(key),
      setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: (key) => sessionStorage.removeItem(key),
      clear: () => sessionStorage.clear(),
      key: (index) => sessionStorage.key(index),
    }
    spyOn(storage, method).mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError')
    })
    expect(
      captureProviderBrowserReturn(new URL(`https://app.example/oauth/tinfoil?code=code&state=${state}`), {
        ...dependencies,
        storage: () => storage,
      }),
    ).toBeNull()
    expect(dependencies.exchangeTinfoil).not.toHaveBeenCalled()
  },
)
it.each(['tinfoil', 'openrouter'] as const)(
  'redirects %s in the same tab and consumes its exchange once',
  async (provider) => {
    const dependencies = deps()
    await startProviderBrowserConnection(
      provider,
      'connections',
      { provider, revision: '1' },
      new AbortController().signal,
      dependencies,
    )
    const authorization = new URL(dependencies.navigate.mock.calls[0][0])
    const callback = new URL(authorization.searchParams.get(provider === 'tinfoil' ? 'redirect_uri' : 'callback_url')!)
    callback.search = new URLSearchParams({ code: 'code', state }).toString()
    const returned = captureProviderBrowserReturn(callback, dependencies)!
    expect(returned.returnTo).toBe('/settings/connections')
    expect(sessionStorage.getItem('thunderbolt.provider.browser-authorization')).toBeNull()
    expect(captureProviderBrowserReturn(callback, dependencies)).toBe(returned)
    await Promise.all([returned.complete(), returned.complete()])
    expect(
      provider === 'tinfoil' ? dependencies.exchangeTinfoil : dependencies.exchangeOpenRouter,
    ).toHaveBeenCalledTimes(1)
  },
)
it.each(['wrong-state', 'wrong-origin', 'wrong-path', 'duplicate-state'] as const)(
  'rejects %s without consuming valid pending state',
  async (kind) => {
    const dependencies = deps()
    await startProviderBrowserConnection(
      'tinfoil',
      'onboarding',
      { provider: 'tinfoil', revision: '1' },
      new AbortController().signal,
      dependencies,
    )
    const callback = new URL(`https://app.example/oauth/tinfoil?code=code&state=${state}`)
    if (kind === 'wrong-state') {
      callback.searchParams.set('state', 'wrong')
    }
    if (kind === 'wrong-origin') {
      callback.hostname = 'evil.example'
    }
    if (kind === 'wrong-path') {
      callback.pathname = '/other'
    }
    if (kind === 'duplicate-state') {
      callback.searchParams.append('state', state)
    }
    expect(captureProviderBrowserReturn(callback, dependencies)).toBeNull()
    expect(sessionStorage.getItem('thunderbolt.provider.browser-authorization')).not.toBeNull()
  },
)
it.each(['expired', 'denied', 'missing-code', 'duplicate-code'] as const)(
  'rejects %s without exchanging a token',
  async (kind) => {
    const dependencies = deps()
    await startProviderBrowserConnection(
      'tinfoil',
      'onboarding',
      { provider: 'tinfoil', revision: '1' },
      new AbortController().signal,
      dependencies,
    )
    const callback = new URL(`https://app.example/oauth/tinfoil?code=code&state=${state}`)
    if (kind === 'expired') {
      dependencies.now = () => 700000
    }
    if (kind === 'denied') {
      callback.searchParams.set('error', 'access_denied')
    }
    if (kind === 'missing-code') {
      callback.searchParams.delete('code')
    }
    if (kind === 'duplicate-code') {
      callback.searchParams.append('code', 'other')
    }
    const returned = captureProviderBrowserReturn(callback, dependencies)!
    expect(returned.returnTo).toBe('/chats/new')
    await expect(returned.complete()).rejects.toThrow('Invalid or expired')
    expect(dependencies.exchangeTinfoil).not.toHaveBeenCalled()
  },
)
it('does not redirect an aborted request', async () => {
  const dependencies = deps()
  await expect(
    startProviderBrowserConnection(
      'openrouter',
      'connections',
      { provider: 'openrouter', revision: '1' },
      AbortSignal.abort(),
      dependencies,
    ),
  ).rejects.toThrow()
  expect(dependencies.navigate).not.toHaveBeenCalled()
})

it.each(['openrouter', 'tinfoil'] as const)(
  'returns %s to the initiating chat with query and fragment intact',
  async (provider) => {
    const dependencies = { ...deps(), currentPath: () => '/chats/new?project=work#composer' as const }
    await startProviderBrowserConnection(
      provider,
      'connections',
      { provider, revision: '1' },
      new AbortController().signal,
      dependencies,
    )
    const path = provider === 'openrouter' ? `/oauth/openrouter/${state}` : '/oauth/tinfoil'
    const returned = captureProviderBrowserReturn(
      new URL(`https://app.example${path}?code=code&state=${state}`),
      dependencies,
    )
    expect(returned?.returnTo).toBe('/chats/new?project=work#composer')
  },
)
