/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createMockHttpClient } from '@/test-utils/http-client'
import { createClient } from '@/lib/http'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useConfigStore } from './config-store'
import { fetchConfig } from './config'

const failingClientFor = () => {
  const httpClient = createMockHttpClient(null, 'http://unreachable.local')
  return {
    ...httpClient,
    get: () => {
      const p = Promise.reject(new Error('Network error')) as ReturnType<typeof httpClient.get>
      p.json = () => p as unknown as Promise<never>
      p.text = () => p as unknown as Promise<never>
      return p
    },
  }
}

describe('fetchConfig', () => {
  const originalSettings = useLocalSettingsStore.getState()
  beforeEach(() => {
    useLocalSettingsStore.setState({ cloudUrl: 'http://test-api.local' })
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  afterEach(() => {
    useLocalSettingsStore.setState(originalSettings)
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  it('returns config from the backend and updates the store', async () => {
    const httpClient = createMockHttpClient({ builtInAgentEnabled: true })

    const result = await fetchConfig('http://test-api.local', httpClient)

    expect(result).toEqual({ builtInAgentEnabled: true })
    expect(useConfigStore.getState().config).toEqual({ builtInAgentEnabled: true })
  })

  it('settles locally and clears stale server policy without a request in standalone mode', async () => {
    useConfigStore.setState({ config: { minimalMode: true, minAppVersion: '99.0.0' }, forceUpgrade: true })
    const client = createMockHttpClient({})
    const get = mock(client.get)
    expect(await fetchConfig('', { ...client, get })).toEqual({})
    expect(get).not.toHaveBeenCalled()
    expect(useConfigStore.getState()).toMatchObject({ config: {}, configLoaded: true, forceUpgrade: false })
  })

  it('returns null and preserves cached store value when backend is unreachable', async () => {
    useConfigStore.getState().updateConfig({ builtInAgentEnabled: true })

    const httpClient = createMockHttpClient(null, 'http://unreachable.local')
    const failingClient = {
      ...httpClient,
      get: () => {
        const p = Promise.reject(new Error('Network error')) as ReturnType<typeof httpClient.get>
        p.json = () => p as unknown as Promise<never>
        p.text = () => p as unknown as Promise<never>
        return p
      },
    }

    const result = await fetchConfig('http://test-api.local', failingClient)

    expect(result).toBeNull()
    expect(useConfigStore.getState().config).toEqual({ builtInAgentEnabled: true })
  })

  it('marks a persisted config as loaded when the fetch fails', async () => {
    useConfigStore.setState({ config: { minimalMode: true }, configLoaded: false })

    await fetchConfig('http://test-api.local', failingClientFor())

    expect(useConfigStore.getState().configLoaded).toBe(true)
  })

  it('marks an empty config as loaded when the fetch fails, so standalone mode keeps its defaults', async () => {
    await fetchConfig('http://test-api.local', failingClientFor())

    expect(useConfigStore.getState().configLoaded).toBe(true)
  })

  it('marks the config as loaded when the fetch succeeds', async () => {
    await fetchConfig('http://test-api.local', createMockHttpClient({ builtInAgentEnabled: true }))

    expect(useConfigStore.getState().configLoaded).toBe(true)
  })

  it.each([true, false])('ignores the old server after a switch (successful response: %s)', async (success) => {
    const response = Promise.withResolvers<Response>()
    const client = createClient({ prefixUrl: 'http://test-api.local', fetch: () => response.promise })
    const pending = fetchConfig('http://test-api.local', client)
    useLocalSettingsStore.setState({ cloudUrl: 'https://next.example/v1' })
    useConfigStore.setState({ config: { builtInAgentEnabled: true }, configLoaded: false })
    if (success) {
      response.resolve(Response.json({ minimalMode: true, authMode: 'oidc', minAppVersion: '99.0.0' }))
    } else {
      response.reject(new Error('Offline'))
    }
    expect(await pending).toBeNull()
    expect(useConfigStore.getState()).toMatchObject({ config: { builtInAgentEnabled: true }, configLoaded: false })
  })
})
