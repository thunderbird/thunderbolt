/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { mockAuth } from '@/test-utils/mock-auth'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createMcpProxyRoutes } from './routes'
import * as settingsModule from '@/config/settings'

// Mock DNS — external Node API, acceptable per docs/testing.md "When You Must Mock"
const mockDnsLookup = mock(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
mock.module('node:dns', () => ({ promises: { lookup: mockDnsLookup } }))
mock.module('node:net', () => ({ isIP: (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0) }))

describe('MCP Proxy Routes', () => {
  let app: { handle: Elysia['handle'] }
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
    corsAllowCredentials: true,
    corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
    corsAllowHeaders:
      'Content-Type,Authorization,X-Mcp-Target-Url,Mcp-Authorization,Mcp-Session-Id,Mcp-Protocol-Version',
    corsExposeHeaders: 'mcp-session-id,set-auth-token',
    waitlistEnabled: false,
    waitlistAutoApproveDomains: '',
    powersyncUrl: '',
    powersyncJwtKid: '',
    powersyncJwtSecret: '',
    powersyncTokenExpirySeconds: 3600,
    authMode: 'consumer' as const,
    oidcClientId: '',
    oidcClientSecret: '',
    oidcIssuer: '',
    betterAuthUrl: 'http://localhost:8000',
  }

  beforeAll(() => {
    consoleSpies = setupConsoleSpy()
    getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue(
      mockSettings as ReturnType<typeof settingsModule.getSettings>,
    )
    mockFetch = mock(() => Promise.resolve(createMockResponse('{"ok":true}')))
    app = new Elysia().use(createMcpProxyRoutes(mockAuth, mockFetch as unknown as typeof fetch))
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

  it('blocks private IP addresses (cloud metadata, RFC 1918, CGNAT, benchmarking)', async () => {
    const blockedUrls = [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/internal',
      'http://192.168.1.1/admin',
      'http://172.16.0.1/secret',
      'http://100.64.0.1/internal', // RFC 6598 CGNAT
      'http://100.127.255.254/internal', // RFC 6598 upper bound
      'http://198.18.0.1/internal', // RFC 2544 benchmarking
      'http://198.19.255.254/internal', // RFC 2544 upper bound
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

  it('blocks loopback MCP server URLs', async () => {
    const loopbackUrls = ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']

    for (const targetUrl of loopbackUrls) {
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

  it('strips Thunderbolt auth and rewrites Mcp-Authorization for remote server', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: {
          'x-mcp-target-url': 'https://mcp.example.com',
          authorization: 'Bearer thunderbolt-session-token',
          'mcp-authorization': 'Bearer mcp-server-api-key',
          'mcp-session-id': 'session-123',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    const [, callOpts] = mockFetch.mock.calls[0]
    const hdrs =
      typeof callOpts.headers?.get === 'function'
        ? Object.fromEntries((callOpts.headers as Headers).entries())
        : callOpts.headers

    // Mcp-Authorization is rewritten to Authorization for the remote server
    expect(hdrs.authorization).toBe('Bearer mcp-server-api-key')
    // MCP headers are preserved
    expect(hdrs['mcp-session-id']).toBe('session-123')
    // Thunderbolt session token must NOT reach the remote server
    expect(hdrs['cookie']).toBeUndefined()
    expect(hdrs['x-mcp-target-url']).toBeUndefined()
    // Mcp-Authorization is consumed by the proxy, not forwarded as-is
    expect(hdrs['mcp-authorization']).toBeUndefined()
  })

  it('strips Thunderbolt auth even when no Mcp-Authorization is provided', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: {
          'x-mcp-target-url': 'https://mcp.example.com',
          authorization: 'Bearer thunderbolt-session-token',
          'mcp-session-id': 'session-123',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )

    const [, callOpts] = mockFetch.mock.calls[0]
    const hdrs =
      typeof callOpts.headers?.get === 'function'
        ? Object.fromEntries((callOpts.headers as Headers).entries())
        : callOpts.headers

    // Thunderbolt session token must NOT reach the remote server
    expect(hdrs.authorization).toBeUndefined()
    expect(hdrs['mcp-session-id']).toBe('session-123')
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

  it('adds security headers to prevent XSS via proxied content', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('<html><script>alert("xss")</script></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ),
    )

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'https://mcp.example.com' },
      }),
    )

    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('adds security headers for non-HTML content types too', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('{"ok":true}')))

    const response = await app.handle(
      new Request('http://localhost/mcp-proxy/', {
        method: 'POST',
        headers: { 'x-mcp-target-url': 'https://mcp.example.com' },
      }),
    )

    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
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
