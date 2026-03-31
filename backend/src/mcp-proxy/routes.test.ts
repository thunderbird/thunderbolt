import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createMcpProxyRoutes } from './routes'
import * as settingsModule from '@/config/settings'

// Mock DNS — external Node API, acceptable per docs/testing.md "When You Must Mock"
const mockDnsLookup = mock(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
mock.module('node:dns', () => ({ promises: { lookup: mockDnsLookup } }))
mock.module('node:net', () => ({ isIP: (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0) }))

describe('MCP Proxy Routes', () => {
  let app: Elysia
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies
  let mockFetch: ReturnType<typeof mock>

  const createMockResponse = (body: string, options: ResponseInit = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...options })

  const mockSettings = {
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
  }

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(mockSettings as ReturnType<typeof settingsModule.getSettings>)
    mockFetch = mock(() => Promise.resolve(createMockResponse('{"ok":true}')))
    // No auth passed — tests run without authentication guard
    app = new Elysia().use(createMcpProxyRoutes(mockFetch as unknown as typeof fetch))
  })

  afterAll(() => {
    getSettingsSpy?.mockRestore()
    consoleSpies.restore()
  })

  beforeEach(() => {
    mockFetch.mockClear()
    mockDnsLookup.mockClear()
    mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
    consoleSpies.error.mockClear()
  })

  // --- Validation ---

  it('returns 400 when X-Mcp-Target-Url header is missing', async () => {
    const response = await app.handle(new Request('http://localhost/mcp-proxy/', { method: 'POST' }))

    expect(response.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(await response.text()).toBe('Missing X-Mcp-Target-Url header')
  })

  it('rejects non-HTTP protocols', async () => {
    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'ftp://files.example.com' },
      }),
    )

    expect(response.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // --- SSRF Protection ---

  it('blocks private IP addresses (cloud metadata, RFC 1918)', async () => {
    const blockedUrls = [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/internal',
      'http://192.168.1.1/admin',
      'http://172.16.0.1/secret',
    ]

    for (const targetUrl of blockedUrls) {
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

  it('blocks DNS rebinding attacks (hostname resolving to private IP)', async () => {
    // Simulate 169.254.169.254.nip.io resolving to cloud metadata IP
    mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '169.254.169.254', family: 4 }]))

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'https://169.254.169.254.nip.io/latest/meta-data/' },
      }),
    )

    expect(response.status).toBe(500) // safeFetch throws, caught by error handler
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('allows localhost MCP server URLs', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'http://localhost:8080' },
      }),
    )

    expect(response.status).toBe(200)
    expect(mockFetch).toHaveBeenCalled()
  })

  // --- Response Security ---

  it('strips set-cookie from proxied responses', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('ok', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'session=attacker-value; Path=/; HttpOnly',
          },
        }),
      ),
    )

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'https://mcp.example.com' },
      }),
    )

    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('rejects responses exceeding 10MB via Content-Length', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('', {
          status: 200,
          headers: { 'content-length': String(11 * 1024 * 1024) },
        }),
      ),
    )

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'https://mcp.example.com' },
      }),
    )

    expect(response.status).toBe(502)
    expect(await response.text()).toBe('Response too large')
  })

  it('returns redirect responses as-is (redirect: manual)', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
      ),
    )

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'https://mcp.example.com' },
      }),
    )

    // 302 is returned to the client, not followed by the proxy
    expect(response.status).toBe(302)
  })

  // --- Header Forwarding ---

  it('forwards Authorization and MCP headers, strips host/cookie/proxy headers', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: {
          'x-mcp-target-url': 'https://mcp.example.com',
          authorization: 'Bearer test-token',
          'mcp-session-id': 'session-123',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    const [, callOpts] = mockFetch.mock.calls[0]
    const hdrs = callOpts.headers instanceof Headers ? Object.fromEntries(callOpts.headers.entries()) : callOpts.headers

    expect(hdrs.authorization).toBe('Bearer test-token')
    expect(hdrs['mcp-session-id']).toBe('session-123')
    expect(hdrs['host']).toBeUndefined()
    expect(hdrs['cookie']).toBeUndefined()
    expect(hdrs['x-mcp-target-url']).toBeUndefined()
  })

  // --- Routing ---

  it('appends sub-path to target URL', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    await app.handle(
      new Request('http://localhost/mcp-proxy/tools/call', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'https://mcp.example.com', 'content-type': 'application/json' },
        body: '{}',
      }),
    )

    const [calledUrl] = mockFetch.mock.calls[0]
    expect(calledUrl).toContain('/tools/call')
  })

  it('sets cross-origin-resource-policy on response', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'https://mcp.example.com' },
      }),
    )

    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
  })
})
