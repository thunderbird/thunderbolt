/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createProxyRoutes } from './proxy'
import * as settingsModule from '@/config/settings'

// Mock DNS — external Node API, acceptable per docs/testing.md "When You Must Mock"
const mockDnsLookup = mock(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
mock.module('node:dns', () => ({ promises: { lookup: mockDnsLookup } }))
mock.module('node:net', () => ({ isIP: (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0) }))

/** Converts a URL to its IP-pinned equivalent (as createSafeFetch would produce). */
const pinnedUrl = (url: string) => {
  const parsed = new URL(url)
  parsed.hostname = '93.184.216.34'
  return parsed.toString()
}

describe('Proxy Routes', () => {
  let app: { handle: Elysia['handle'] }
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies
  let mockFetch: ReturnType<typeof mock>

  const createMockResponse = (body: string, options: ResponseInit = {}) => {
    const defaultOptions = {
      status: 200,
      headers: {
        'content-type': 'image/x-icon',
        'content-length': body.length.toString(),
        'cache-control': 'max-age=3600',
      },
      ...options,
    }

    return new Response(body, defaultOptions)
  }

  beforeAll(async () => {
    consoleSpies = setupConsoleSpy()

    // Mock settings
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
      corsAllowCredentials: true,
      corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      corsAllowHeaders: 'Content-Type,Authorization',
      corsExposeHeaders: '',
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
      betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
      rateLimitEnabled: false,
      swaggerEnabled: false,
      e2eeEnabled: false,
      trustedProxy: '',
      samlEntryPoint: '',
      samlEntityId: '',
      samlIdpIssuer: '',
      samlCert: '',
    })

    // Create mock fetch
    mockFetch = mock(() => Promise.resolve(createMockResponse('test content')))

    // Inject mock fetch into routes
    app = new Elysia().use(createProxyRoutes(mockFetch as unknown as typeof fetch))
  })

  afterAll(() => {
    getSettingsSpy?.mockRestore()
    consoleSpies.restore()
  })

  beforeEach(() => {
    // Reset all mocks before each test
    mockFetch.mockClear()
    mockDnsLookup.mockClear()
    mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
    consoleSpies.error.mockClear()
  })

  describe('GET /proxy/*', () => {
    it('should proxy a valid URL successfully', async () => {
      const targetUrl = 'https://example.com/favicon.ico'
      const mockBody = 'favicon content'

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse(mockBody)))

      const response = await app.handle(
        new Request(`http://localhost/proxy/${targetUrl}`, {
          method: 'GET',
        }),
      )

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [calledUrl, calledInit] = mockFetch.mock.calls[0]
      expect(calledUrl).toBe(pinnedUrl(targetUrl))
      const headers = calledInit.headers as Headers
      expect(headers.get('Host')).toBe('example.com')

      const body = await response.text()
      expect(body).toBe(mockBody)
    })

    it('should forward relevant headers from proxied response', async () => {
      const targetUrl = 'https://example.com/image.png'

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          createMockResponse('image data', {
            headers: {
              'content-type': 'image/png',
              'content-length': '12345',
              'cache-control': 'public, max-age=86400',
              etag: '"abc123"',
              'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
            },
          }),
        ),
      )

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
      expect(response.headers.get('etag')).toBe('"abc123"')
      expect(response.headers.get('last-modified')).toBe('Mon, 01 Jan 2024 00:00:00 GMT')
    })

    it('should add CORS headers to the response', async () => {
      const targetUrl = 'https://example.com/resource'

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('content')))

      // Make request with Origin header matching default CORS settings
      const response = await app.handle(
        new Request(`http://localhost/proxy/${targetUrl}`, {
          method: 'GET',
          headers: { Origin: 'http://localhost:1420' },
        }),
      )

      expect(response.status).toBe(200)
      // CORS headers are set by the @elysiajs/cors plugin based on settings
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(true)
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    })

    it('should return 400 when no URL is provided', async () => {
      const response = await app.handle(new Request('http://localhost/proxy/', { method: 'GET' }))

      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()

      const body = await response.text()
      expect(body).toBe('No URL provided')
    })

    it('should return 400 when invalid URL is provided', async () => {
      const invalidUrl = 'not-a-valid-url'

      const response = await app.handle(new Request(`http://localhost/proxy/${invalidUrl}`, { method: 'GET' }))

      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()

      const body = await response.text()
      expect(body).toBe('Invalid URL')
    })

    it('should return 400 when URL has malformed encoding', async () => {
      // This URL has a % not followed by valid hex digits, which will cause decodeURIComponent to throw
      const malformedUrl = 'https://example.com/%ZZ'

      const response = await app.handle(new Request(`http://localhost/proxy/${malformedUrl}`, { method: 'GET' }))

      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()

      const body = await response.text()
      expect(body).toBe('Invalid URL encoding')
    })

    it('should handle URL-encoded target URLs', async () => {
      const targetUrl = 'https://example.com/favicon.ico?v=2'
      const encodedTargetUrl = encodeURIComponent(targetUrl)
      const mockBody = 'favicon content'

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse(mockBody)))

      const response = await app.handle(
        new Request(`http://localhost/proxy/${encodedTargetUrl}`, {
          method: 'GET',
        }),
      )

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [calledUrl] = mockFetch.mock.calls[0]
      expect(calledUrl).toBe(pinnedUrl(targetUrl))

      const body = await response.text()
      expect(body).toBe(mockBody)
    })

    it('should handle non-200 responses from proxied URL', async () => {
      const targetUrl = 'https://example.com/not-found'

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response('Not Found', {
            status: 404,
            statusText: 'Not Found',
          }),
        ),
      )

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(404)
      expect(mockFetch).toHaveBeenCalledWith(pinnedUrl(targetUrl), expect.any(Object))

      const body = await response.text()
      expect(body).toBe('Failed to fetch resource: Not Found')
    })

    it('should handle 500 errors from proxied URL', async () => {
      const targetUrl = 'https://example.com/error'

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response('Internal Server Error', {
            status: 500,
            statusText: 'Internal Server Error',
          }),
        ),
      )

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(500)
      expect(mockFetch).toHaveBeenCalledWith(pinnedUrl(targetUrl), expect.any(Object))

      const body = await response.text()
      expect(body).toBe('Failed to fetch resource: Internal Server Error')
    })

    it('should handle network errors gracefully', async () => {
      const targetUrl = 'https://example.com/resource'
      const networkError = new Error('Network connection failed')

      mockFetch.mockImplementation(() => Promise.reject(networkError))

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(500)

      const body = await response.text()
      expect(body).toBe('Proxy request failed')
    })

    it('should handle URLs with query parameters', async () => {
      const targetUrl = 'https://example.com/api/data?param1=value1&param2=value2'

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('data')))

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(pinnedUrl(targetUrl), expect.any(Object))
    })

    it('should handle URLs with different protocols', async () => {
      const httpUrl = 'http://example.com/resource'
      const httpsUrl = 'https://example.com/resource'

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('content')))

      const httpResponse = await app.handle(new Request(`http://localhost/proxy/${httpUrl}`, { method: 'GET' }))
      expect(httpResponse.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(pinnedUrl(httpUrl), expect.any(Object))

      mockFetch.mockClear()

      const httpsResponse = await app.handle(new Request(`http://localhost/proxy/${httpsUrl}`, { method: 'GET' }))
      expect(httpsResponse.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(pinnedUrl(httpsUrl), expect.any(Object))
    })

    it('should handle URLs with special characters when properly encoded', async () => {
      const targetUrl = 'https://example.com/path/with spaces/file.ico'
      const encodedTargetUrl = encodeURIComponent(targetUrl)

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('content')))

      const response = await app.handle(new Request(`http://localhost/proxy/${encodedTargetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(pinnedUrl(targetUrl), expect.any(Object))
    })

    it('should stream response body', async () => {
      const targetUrl = 'https://example.com/large-file'
      const largeContent = 'x'.repeat(10000)

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse(largeContent)))

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(response.body).toBeTruthy()

      const body = await response.text()
      expect(body.length).toBe(10000)
    })

    it('should block requests to localhost', async () => {
      const response = await app.handle(
        new Request('http://localhost/proxy/http://127.0.0.1/secret', { method: 'GET' }),
      )

      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()

      const body = await response.text()
      expect(body).toBe('Internal URLs are not allowed')
    })

    it('should block requests to cloud metadata endpoints', async () => {
      const response = await app.handle(
        new Request('http://localhost/proxy/http://169.254.169.254/latest/meta-data/', { method: 'GET' }),
      )

      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()

      const body = await response.text()
      expect(body).toBe('Internal URLs are not allowed')
    })

    it('should block requests to private network addresses', async () => {
      const urls = ['http://10.0.0.1/internal', 'http://192.168.1.1/admin', 'http://172.16.0.1/secret']

      for (const url of urls) {
        mockFetch.mockClear()
        const response = await app.handle(new Request(`http://localhost/proxy/${url}`, { method: 'GET' }))

        expect(response.status).toBe(400)
        expect(mockFetch).not.toHaveBeenCalled()
      }
    })

    it('should block non-HTTP protocols', async () => {
      const response = await app.handle(new Request('http://localhost/proxy/file:///etc/passwd', { method: 'GET' }))

      expect(response.status).toBe(400)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should add security headers to prevent XSS via proxied content', async () => {
      const targetUrl = 'https://example.com/page.html'

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          createMockResponse('<html><script>alert("xss")</script></html>', {
            headers: {
              'content-type': 'text/html; charset=utf-8',
            },
          }),
        ),
      )

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toBe('sandbox')
      expect(response.headers.get('content-disposition')).toBe('attachment')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    })

    it('should add security headers for non-HTML content types too', async () => {
      const targetUrl = 'https://example.com/data.json'

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          createMockResponse('{"key":"value"}', {
            headers: {
              'content-type': 'application/json',
            },
          }),
        ),
      )

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toBe('sandbox')
      expect(response.headers.get('content-disposition')).toBe('attachment')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    })

    it('should not forward headers that are not in the allowed list', async () => {
      const targetUrl = 'https://example.com/resource'

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          createMockResponse('content', {
            headers: {
              'content-type': 'text/plain',
              'set-cookie': 'session=abc123',
              'x-custom-header': 'custom-value',
            },
          }),
        ),
      )

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/plain')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(response.headers.get('x-custom-header')).toBeNull()
    })
  })
})
