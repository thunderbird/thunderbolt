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

describe('buildAuthUrl', () => {
  // The configured=false test runs first and invalidates the module cache so the
  // configured=true test gets a fresh fetch. Ordering matters here.

  it('throws a clear error when Google OAuth is not configured', async () => {
    const httpClient = createMockHttpClient([{ client_id: '', configured: false }])
    const promise = buildAuthUrl(httpClient, 'state-abc', 'challenge-xyz')
    await expect(promise).rejects.toThrow(
      'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the backend before enabling Google integration.',
    )
  })

  it('builds the auth URL when configured', async () => {
    const httpClient = createMockHttpClient([{ client_id: 'test-google-client-id', configured: true }])
    const url = await buildAuthUrl(httpClient, 'state-abc', 'challenge-xyz')
    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url).toContain('client_id=test-google-client-id')
    expect(url).toContain('state=state-abc')
    expect(url).toContain('code_challenge=challenge-xyz')
  })
})
