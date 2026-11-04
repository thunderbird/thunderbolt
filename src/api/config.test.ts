/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createMockHttpClient } from '@/test-utils/http-client'
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
  beforeEach(() => {
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  afterEach(() => {
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  it('returns config from the backend and updates the store', async () => {
    const httpClient = createMockHttpClient({ builtInAgentEnabled: true })

    const result = await fetchConfig('http://test-api.local', httpClient)

    expect(result).toEqual({ builtInAgentEnabled: true })
    expect(useConfigStore.getState().config).toEqual({ builtInAgentEnabled: true })
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
})
