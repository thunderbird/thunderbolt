/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { fetch } from './fetch'
import { createProxyFetch, type ProxyFetchOptions } from './proxy-fetch'

const originalNativeFetch = useLocalSettingsStore.getState().isNativeFetchEnabled

afterEach(() => {
  useLocalSettingsStore.setState({ isNativeFetchEnabled: originalNativeFetch })
})

it.each(['developer', 'proxy'] as const)('uses native HTTP without capability IPC in the %s path', async (path) => {
  useLocalSettingsStore.setState({ isNativeFetchEnabled: true })
  const native = mock<NonNullable<ProxyFetchOptions['tauriFetch']>>(async () => new Response(null, { status: 204 }))
  const browser = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async () => {
        throw new Error('Unexpected browser fetch')
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  try {
    const response =
      path === 'developer'
        ? await fetch('http://localhost:1234/v1', undefined, { isTauri: () => true, tauriFetch: native })
        : await createProxyFetch({
            cloudUrl: 'https://backend.example/v1',
            isStandalone: () => true,
            getProxyEnabled: () => false,
            tauriFetch: native,
          })('http://localhost:1234/v1')
    expect(response.status).toBe(204)
    expect(native.mock.calls[0][1]?.maxRedirections).toBe(0)
    expect(browser).not.toHaveBeenCalled()
  } finally {
    browser.mockRestore()
  }
})

it('never invokes native HTTP on web even with the developer setting on', async () => {
  useLocalSettingsStore.setState({ isNativeFetchEnabled: true })
  const native = mock<NonNullable<ProxyFetchOptions['tauriFetch']>>(async () => new Response('native'))
  const browser = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => new Response('web'), { preconnect: globalThis.fetch.preconnect }),
  )
  try {
    expect(
      await (await fetch('https://provider.example', undefined, { isTauri: () => false, tauriFetch: native })).text(),
    ).toBe('web')
    expect(native).not.toHaveBeenCalled()
  } finally {
    browser.mockRestore()
  }
})
