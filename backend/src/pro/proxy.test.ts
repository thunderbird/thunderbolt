import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createProxyRoutes } from './proxy'

describe('Proxy Routes', () => {
  let app: Elysia
  let fetchSpy: ReturnType<typeof spyOn>
  let consoleSpy: ReturnType<typeof spyOn>
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
    // Suppress console output during tests
    consoleSpy = spyOn(console, 'error').mockImplementation(() => {})

    // Mock global fetch
    mockFetch = mock(() => Promise.resolve(createMockResponse('test content')))
    fetchSpy = spyOn(global, 'fetch').mockImplementation(mockFetch as any)

    app = new Elysia().use(createProxyRoutes())
  })

  afterAll(() => {
    fetchSpy?.mockRestore()
    consoleSpy?.mockRestore()
  })

  beforeEach(() => {
    // Reset all mocks before each test
    mockFetch.mockClear()
    consoleSpy.mockClear()
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
      expect(mockFetch).toHaveBeenCalledWith(
        targetUrl,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'User-Agent': 'Mozilla/5.0 (compatible; ThunderboltBot/1.0)',
          }),
        }),
      )

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
      expect(body).toBe('Invalid URL provided')
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
      expect(mockFetch).toHaveBeenCalledWith(targetUrl, expect.any(Object))

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
      expect(mockFetch).toHaveBeenCalledWith(targetUrl, expect.any(Object))

      const body = await response.text()
      expect(body).toBe('Failed to fetch resource: Internal Server Error')
    })

    it('should handle network errors gracefully', async () => {
      const targetUrl = 'https://example.com/resource'
      const networkError = new Error('Network connection failed')

      mockFetch.mockImplementation(() => Promise.reject(networkError))

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(500)
      expect(consoleSpy).toHaveBeenCalledWith('Proxy error:', networkError)

      const body = await response.text()
      expect(body).toBe('Proxy request failed')
    })

    it('should handle URLs with query parameters', async () => {
      const targetUrl = 'https://example.com/api/data?param1=value1&param2=value2'

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('data')))

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(targetUrl, expect.any(Object))
    })

    it('should handle URLs with different protocols', async () => {
      const httpUrl = 'http://example.com/resource'
      const httpsUrl = 'https://example.com/resource'

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('content')))

      const httpResponse = await app.handle(new Request(`http://localhost/proxy/${httpUrl}`, { method: 'GET' }))
      expect(httpResponse.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(httpUrl, expect.any(Object))

      mockFetch.mockClear()

      const httpsResponse = await app.handle(new Request(`http://localhost/proxy/${httpsUrl}`, { method: 'GET' }))
      expect(httpsResponse.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(httpsUrl, expect.any(Object))
    })

    it('should handle URLs with special characters', async () => {
      const targetUrl = 'https://example.com/path/with%20spaces/file.ico'

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse('content')))

      const response = await app.handle(new Request(`http://localhost/proxy/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(targetUrl, expect.any(Object))
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
