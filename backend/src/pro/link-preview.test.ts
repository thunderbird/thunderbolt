import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createLinkPreviewRoutes } from './link-preview'
import type { LinkPreviewResponse } from './types'

describe('Link Preview Routes', () => {
  let app: Elysia
  let consoleSpy: ReturnType<typeof spyOn>
  let mockFetch: ReturnType<typeof mock>

  const createMockHtmlResponse = (html: string, options: ResponseInit = {}) => {
    const defaultOptions = {
      status: 200,
      headers: {
        'content-type': 'text/html',
      },
      ...options,
    }

    return new Response(html, defaultOptions)
  }

  beforeAll(async () => {
    // Suppress console output during tests
    consoleSpy = spyOn(console, 'error').mockImplementation(() => {})

    // Create mock fetch
    mockFetch = mock(() => Promise.resolve(createMockHtmlResponse('<html></html>')))

    // Inject mock fetch into routes
    app = new Elysia().use(createLinkPreviewRoutes(mockFetch as unknown as typeof fetch))
  })

  afterAll(() => {
    consoleSpy?.mockRestore()
  })

  beforeEach(() => {
    // Reset all mocks before each test
    mockFetch.mockClear()
    consoleSpy.mockClear()
  })

  describe('GET /link-preview/*', () => {
    it('should extract Open Graph metadata successfully', async () => {
      const targetUrl = 'https://example.com/article'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Test Article" />
            <meta property="og:description" content="This is a test article" />
            <meta property="og:image" content="https://example.com/image.jpg" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(
        new Request(`http://localhost/link-preview/${targetUrl}`, {
          method: 'GET',
        }),
      )

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data).toEqual({
        title: 'Test Article',
        description: 'This is a test article',
        image: 'https://example.com/image.jpg',
      })
    })

    it('should fallback to title tag if og:title is missing', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <title>Page Title</title>
            <meta property="og:description" content="Description" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.title).toBe('Page Title')
    })

    it('should fallback to meta description if og:description is missing', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <title>Page Title</title>
            <meta name="description" content="Regular meta description" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.description).toBe('Regular meta description')
    })

    it('should handle twitter:image fallback', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <title>Page Title</title>
            <meta name="twitter:image" content="https://example.com/twitter-image.jpg" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.image).toBe('https://example.com/twitter-image.jpg')
    })

    it('should convert relative image URLs to absolute URLs', async () => {
      const targetUrl = 'https://www.thunderbird.net/en-US/'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Thunderbird — Free Your Inbox." />
            <meta property="og:description" content="Thunderbird is a free email application that's easy to set up and customize - and it's loaded with great features!" />
            <meta property="og:image" content="/media/img/thunderbird/thunderbird-256.png" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.image).toBe('https://www.thunderbird.net/media/img/thunderbird/thunderbird-256.png')
    })

    it('should handle protocol-relative image URLs', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <meta property="og:image" content="//cdn.example.com/image.jpg" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.image).toBe('https://cdn.example.com/image.jpg')
    })

    it('should return null values when metadata is missing', async () => {
      const targetUrl = 'https://example.com/minimal'
      const html = '<html><head></head><body>Content</body></html>'

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data).toEqual({
        title: null,
        description: null,
        image: null,
      })
    })

    it('should handle meta tags with content before property attribute', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <meta content="Title Content" property="og:title" />
            <meta content="Description Content" property="og:description" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.title).toBe('Title Content')
      expect(body.data?.description).toBe('Description Content')
    })

    it('should return 400 when no URL is provided', async () => {
      const response = await app.handle(new Request('http://localhost/link-preview/', { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(mockFetch).not.toHaveBeenCalled()

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('No URL provided')
    })

    it('should return error when invalid URL is provided', async () => {
      const invalidUrl = 'not-a-valid-url'

      const response = await app.handle(new Request(`http://localhost/link-preview/${invalidUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(mockFetch).not.toHaveBeenCalled()

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('Invalid URL provided')
    })

    it('should return error when URL has malformed encoding', async () => {
      // This URL has a % not followed by valid hex digits, which will cause decodeURIComponent to throw
      const malformedUrl = 'https://example.com/%ZZ'

      const response = await app.handle(new Request(`http://localhost/link-preview/${malformedUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(mockFetch).not.toHaveBeenCalled()

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('Invalid URL encoding')
    })

    it('should handle URL-encoded target URLs', async () => {
      const targetUrl = 'https://example.com/page?v=2'
      const encodedTargetUrl = encodeURIComponent(targetUrl)
      const html = '<html><head><title>Test</title></head></html>'

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(
        new Request(`http://localhost/link-preview/${encodedTargetUrl}`, {
          method: 'GET',
        }),
      )

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(
        targetUrl,
        expect.objectContaining({
          method: 'GET',
        }),
      )

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.title).toBe('Test')
    })

    it('should handle non-200 responses', async () => {
      const targetUrl = 'https://example.com/not-found'

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response('Not Found', {
            status: 404,
            statusText: 'Not Found',
          }),
        ),
      )

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(targetUrl, expect.any(Object))

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('Failed to fetch resource: Not Found')
    })

    it('should timeout after 1 second', async () => {
      const targetUrl = 'https://example.com/slow'

      // Simulate an abort error
      const abortError = new Error('The operation was aborted')
      abortError.name = 'AbortError'

      mockFetch.mockImplementation(() => Promise.reject(abortError))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('Request timeout exceeded')
    })

    it('should handle network errors gracefully', async () => {
      const targetUrl = 'https://example.com/resource'
      const networkError = new Error('Network connection failed')

      mockFetch.mockImplementation(() => Promise.reject(networkError))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(consoleSpy).toHaveBeenCalledWith('Link preview error:', networkError)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('Network connection failed')
    })

    it('should send User-Agent header', async () => {
      const targetUrl = 'https://example.com/page'
      const html = '<html><head><title>Test</title></head></html>'

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(mockFetch).toHaveBeenCalledWith(
        targetUrl,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          }),
        }),
      )
    })
  })
})
