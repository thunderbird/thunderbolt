import { createClient, type HttpClient } from '@/lib/http'
import { describe, expect, it } from 'bun:test'
import { buildAuthUrl } from './auth'

const createMockHttpClient = (responses: unknown[]): HttpClient => {
  let callCount = 0
  const mockFetch = async (): Promise<Response> => {
    const response = responses[callCount] ?? responses[responses.length - 1]
    callCount++
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return createClient({ prefixUrl: 'http://localhost/', fetch: mockFetch })
}

describe('buildAuthUrl (Microsoft)', () => {
  it('throws a clear error when Microsoft OAuth is not configured', async () => {
    const httpClient = createMockHttpClient([{ client_id: '', configured: false }])
    const promise = buildAuthUrl(httpClient, 'state-abc', 'challenge-xyz')
    await expect(promise).rejects.toThrow(
      'Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET on the backend before enabling Microsoft integration.',
    )
  })

  it('builds the auth URL when configured', async () => {
    const httpClient = createMockHttpClient([{ client_id: 'test-ms-client-id', configured: true }])
    const url = await buildAuthUrl(httpClient, 'state-abc', 'challenge-xyz')
    expect(url).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(url).toContain('client_id=test-ms-client-id')
    expect(url).toContain('state=state-abc')
  })
})
