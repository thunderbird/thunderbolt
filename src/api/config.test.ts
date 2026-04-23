import { describe, expect, it, beforeEach } from 'bun:test'
import { createMockHttpClient } from '@/test-utils/http-client'
import { useConfigStore } from './config-store'
import { fetchConfig } from './config'

describe('fetchConfig', () => {
  beforeEach(() => {
    useConfigStore.getState().updateConfig({})
  })

  it('returns config from the backend and updates the store', async () => {
    const httpClient = createMockHttpClient({ e2eeEnabled: true })

    const result = await fetchConfig('http://test-api.local', httpClient)

    expect(result).toEqual({ e2eeEnabled: true })
    expect(useConfigStore.getState().config).toEqual({ e2eeEnabled: true })
  })

  it('returns null and preserves cached store value when backend is unreachable', async () => {
    useConfigStore.getState().updateConfig({ e2eeEnabled: true })

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
    expect(useConfigStore.getState().config).toEqual({ e2eeEnabled: true })
  })
})
