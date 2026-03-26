import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createMcpProxyRoutes } from './routes'
import * as settingsModule from '@/config/settings'

describe('MCP Proxy Routes', () => {
  let app: Elysia
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies
  let mockFetch: ReturnType<typeof mock>

  const createMockResponse = (body: string, options: ResponseInit = {}) =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...options,
    })

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()

    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
      fireworksApiKey: '',
      mistralApiKey: '',
      anthropicApiKey: '',
      exaApiKey: '',
      thunderboltInferenceUrl: '',
      thunderboltInferenceApiKey: '',
      monitoringToken: '',
      googleClientId: '',
      googleClientSecret: '',
      microsoftClientId: '',
      microsoftClientSecret: '',
      logLevel: 'INFO',
      port: 8000,
      appUrl: 'http://localhost:1420',
      posthogHost: 'https://us.i.posthog.com',
      posthogApiKey: '',
      corsOrigins: 'http://localhost:1420',
      corsOriginRegex: '',
      corsAllowCredentials: true,
      corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      corsAllowHeaders: 'Content-Type,Authorization,X-Mcp-Target-Url,Mcp-Session-Id,Mcp-Protocol-Version',
      corsExposeHeaders: 'mcp-session-id,set-auth-token',
      waitlistEnabled: false,
      waitlistAutoApproveDomains: '',
      powersyncUrl: '',
      powersyncJwtKid: '',
      powersyncJwtSecret: '',
      powersyncTokenExpirySeconds: 3600,
    })

    mockFetch = mock(() => Promise.resolve(createMockResponse('{"ok":true}')))
    app = new Elysia().use(createMcpProxyRoutes(mockFetch as unknown as typeof fetch))
  })

  afterAll(() => {
    getSettingsSpy?.mockRestore()
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockFetch.mockClear()
    consoleSpies.error.mockClear()
  })

  it('returns 400 when X-Mcp-Target-Url header is missing', async () => {
    const response = await app.handle(new Request('http://localhost/mcp-proxy/', { method: 'POST' }))

    expect(response.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()

    const body = await response.text()
    expect(body).toBe('Missing X-Mcp-Target-Url header')
  })

  it('returns 400 for localhost SSRF-blocked URLs', async () => {
    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'http://localhost:8080' },
      }),
    )

    expect(response.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()

    const body = await response.text()
    expect(body).toBe('Internal URLs are not allowed')
  })

  it('returns 400 for private IP SSRF-blocked URLs', async () => {
    const privateUrls = [
      'http://10.0.0.1/internal',
      'http://192.168.1.1/admin',
      'http://172.16.0.1/secret',
      'http://169.254.169.254/latest/meta-data/',
    ]

    for (const targetUrl of privateUrls) {
      mockFetch.mockClear()
      const response = await app.handle(
        new Request('http://localhost/mcp-proxy/', {
          method: 'POST',
          headers: { 'x-mcp-target-url': targetUrl },
        }),
      )

      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()
    }
  })

  it('forwards POST request with body to target', async () => {
    const targetUrl = 'https://mcp.example.com'
    const requestBody = JSON.stringify({ method: 'tools/list', params: {} })

    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"tools":[]}', { status: 200 })))

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: {
          'x-mcp-target-url': targetUrl,
          'content-type': 'application/json',
        },
        body: requestBody,
      }),
    )

    expect(response.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledWith(targetUrl, expect.objectContaining({ method: 'POST' }))
  })

  it('forwards Authorization header to target', async () => {
    const targetUrl = 'https://mcp.example.com'

    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: {
          'x-mcp-target-url': targetUrl,
          authorization: 'Bearer test-token-123',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    expect(mockFetch).toHaveBeenCalledWith(
      targetUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer test-token-123' }),
      }),
    )
  })

  it('forwards Mcp-Session-Id in request and response', async () => {
    const targetUrl = 'https://mcp.example.com'
    const sessionId = 'session-abc-123'

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': sessionId,
          },
        }),
      ),
    )

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: {
          'x-mcp-target-url': targetUrl,
          'mcp-session-id': sessionId,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    // Mcp-Session-Id should be forwarded in the request
    expect(mockFetch).toHaveBeenCalledWith(
      targetUrl,
      expect.objectContaining({
        headers: expect.objectContaining({ 'mcp-session-id': sessionId }),
      }),
    )

    // Mcp-Session-Id from response should pass through
    expect(response.headers.get('mcp-session-id')).toBe(sessionId)
  })

  it('streams SSE response body', async () => {
    const targetUrl = 'https://mcp.example.com/sse'
    const sseChunk = 'data: {"type":"message"}\n\n'

    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(sseChunk, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    )

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/sse', {
        method: 'GET',
        headers: { 'x-mcp-target-url': 'https://mcp.example.com' },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.body).toBeTruthy()

    const body = await response.text()
    expect(body).toBe(sseChunk)
  })

  it('forwards DELETE method', async () => {
    const targetUrl = 'https://mcp.example.com'

    mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })))

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'DELETE',
        headers: { 'x-mcp-target-url': targetUrl },
      }),
    )

    expect(response.status).toBe(204)
    expect(mockFetch).toHaveBeenCalledWith(targetUrl, expect.objectContaining({ method: 'DELETE' }))
  })

  it('strips host and cookie headers before forwarding', async () => {
    const targetUrl = 'https://mcp.example.com'

    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: {
          'x-mcp-target-url': targetUrl,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const forwardedHeaders = init.headers as Record<string, string>

    expect(forwardedHeaders['host']).toBeUndefined()
    expect(forwardedHeaders['cookie']).toBeUndefined()
    expect(forwardedHeaders['x-mcp-target-url']).toBeUndefined()
  })

  it('appends sub-path from route to target URL', async () => {
    const targetUrl = 'https://mcp.example.com'

    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    await app.handle(
      new Request('http://localhost/mcp-proxy/tools/call', {
        method: 'POST',
        headers: {
          'x-mcp-target-url': targetUrl,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    expect(mockFetch).toHaveBeenCalledWith(`${targetUrl}/tools/call`, expect.any(Object))
  })

  it('sets cross-origin-resource-policy on response', async () => {
    const targetUrl = 'https://mcp.example.com'

    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': targetUrl },
      }),
    )

    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
  })
})
