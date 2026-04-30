import { mock } from 'bun:test'
import { createClient, type HttpClient } from '@/lib/http'

/** Build a JSON Response (for use with createSpyHttpClient). */
export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Creates an HTTP client backed by a Bun mock spy, for asserting on requests. */
export const createSpyHttpClient = (
  fetchImpl?: (req: Request) => Promise<Response>,
  defaultResponse: unknown = { success: true },
): { httpClient: HttpClient; fetchSpy: ReturnType<typeof mock> } => {
  const defaultImpl = async () => jsonResponse(defaultResponse)
  const fetchSpy = mock(fetchImpl ?? defaultImpl)
  const httpClient = createClient({
    fetch: fetchSpy as unknown as typeof globalThis.fetch,
    prefixUrl: 'http://test-api.local',
  })
  return { httpClient, fetchSpy }
}
