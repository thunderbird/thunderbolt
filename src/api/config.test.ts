import { describe, expect, it } from 'bun:test'
import { createMockHttpClient } from '@/test-utils/http-client'
import { fetchConfig } from './config'

describe('fetchConfig', () => {
  it('returns config from the backend', async () => {
    const httpClient = createMockHttpClient({ e2eeEnabled: true })

    const result = await fetchConfig('http://test-api.local', httpClient)

    expect(result).toEqual({ e2eeEnabled: true })
  })

  it('returns null when backend is unreachable', async () => {
    const httpClient = createMockHttpClient(null, 'http://unreachable.local')
    // Override with a failing fetch
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
  })
})
