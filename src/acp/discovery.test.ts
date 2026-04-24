import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createClient } from '@/lib/http'
import { fetchRemoteAgentDescriptors } from './discovery'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const validRegistryResponse = {
  version: '1.0',
  agents: [
    {
      id: 'agent-1',
      name: 'Test Agent',
      distribution: { remote: { url: 'wss://example.com/ws', transport: 'websocket', icon: 'brain' } },
    },
    {
      id: 'agent-2',
      name: 'Local Only Agent',
      distribution: {},
    },
  ],
}

const makeClient = (mockFetch: FetchFn) => createClient({ fetch: mockFetch as typeof fetch })

const successFetch =
  (onRequest?: (req: Request) => void): FetchFn =>
  async (input) => {
    const req = input instanceof Request ? input : new Request(input)
    onRequest?.(req)
    return new Response(JSON.stringify(validRegistryResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

describe('fetchRemoteAgentDescriptors', () => {
  const cloudUrl = 'https://example.com/v1'

  // Suppress console.info/warn from discovery logging
  let infoSpy: ReturnType<typeof spyOn>
  let warnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    infoSpy = spyOn(console, 'info').mockImplementation(() => {})
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    infoSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('sends Authorization header with Bearer token when token exists', async () => {
    let capturedReq: Request | undefined
    const httpClient = makeClient(successFetch((req) => (capturedReq = req)))

    await fetchRemoteAgentDescriptors(cloudUrl, {
      getAuthToken: () => 'my-token',
      httpClient,
    })

    expect(capturedReq?.headers.get('Authorization')).toBe('Bearer my-token')
  })

  it('sends no Authorization header when token is null', async () => {
    let capturedReq: Request | undefined
    const httpClient = makeClient(successFetch((req) => (capturedReq = req)))

    await fetchRemoteAgentDescriptors(cloudUrl, {
      getAuthToken: () => null,
      httpClient,
    })

    expect(capturedReq?.headers.get('Authorization')).toBeNull()
  })

  it('includes credentials: include in the request', async () => {
    let capturedReq: Request | undefined
    const httpClient = makeClient(successFetch((req) => (capturedReq = req)))

    await fetchRemoteAgentDescriptors(cloudUrl, {
      getAuthToken: () => 'tok',
      httpClient,
    })

    expect(capturedReq?.credentials).toBe('include')
  })

  it('fetches from the correct URL', async () => {
    let capturedReq: Request | undefined
    const httpClient = makeClient(successFetch((req) => (capturedReq = req)))

    await fetchRemoteAgentDescriptors(cloudUrl, {
      getAuthToken: () => null,
      httpClient,
    })

    expect(capturedReq?.url).toBe('https://example.com/v1/agents')
  })

  it('returns only remote agents from the registry response', async () => {
    const httpClient = makeClient(successFetch())

    const result = await fetchRemoteAgentDescriptors(cloudUrl, {
      getAuthToken: () => null,
      httpClient,
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 'agent-1',
      name: 'Test Agent',
      type: 'remote',
      transport: 'websocket',
      url: 'wss://example.com/ws',
      icon: 'brain',
      isSystem: 1,
      enabled: 1,
    })
  })

  it('defaults icon to globe when not provided', async () => {
    const response = {
      version: '1.0',
      agents: [{ id: 'a1', name: 'No Icon', distribution: { remote: { url: 'wss://x.com', transport: 'websocket' } } }],
    }
    const mockFetch: FetchFn = async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    const httpClient = makeClient(mockFetch)

    const result = await fetchRemoteAgentDescriptors(cloudUrl, {
      getAuthToken: () => null,
      httpClient,
    })

    expect(result[0]?.icon).toBe('globe')
  })

  it('returns empty array on fetch failure', async () => {
    const mockFetch: FetchFn = async () => new Response('Server Error', { status: 500 })
    const httpClient = makeClient(mockFetch)

    const result = await fetchRemoteAgentDescriptors(cloudUrl, {
      getAuthToken: () => 'tok',
      httpClient,
    })

    expect(result).toEqual([])
  })
})
