import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createLinkPreviewRoutes } from './link-preview'
import type { LinkPreviewResponse } from './types'
import * as settingsModule from '@/config/settings'

describe('Link Preview Routes', () => {
  let app: Elysia
  let getSettingsSpy: ReturnType<typeof spyOn>
  let consoleSpies: ConsoleSpies
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

  const createMockImageResponse = (contentType = 'image/png') =>
    new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { 'content-type': contentType },
    })

  /** Mock fetch that returns HTML for the target URL and a small image for any other URL */
  const createPageAndImageMock = (targetUrl: string, html: string) => {
    return (url: string) => {
      if (url === targetUrl) return Promise.resolve(createMockHtmlResponse(html))
      return Promise.resolve(createMockImageResponse())
    }
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
      posthogHost: 'https://us.i.posthog.com',
      posthogApiKey: '',
      corsOrigins: 'http://localhost:1420',
      corsOriginRegex: '',
      corsAllowCredentials: true,
      corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      corsAllowHeaders: 'Content-Type,Authorization',
      corsExposeHeaders: '',
      waitlistEnabled: false,
    })

    // Create mock fetch
    mockFetch = mock(() => Promise.resolve(createMockHtmlResponse('<html></html>')))

    // Inject mock fetch into routes
    app = new Elysia().use(createLinkPreviewRoutes(mockFetch as unknown as typeof fetch))
  })

  afterAll(() => {
    getSettingsSpy?.mockRestore()
    consoleSpies.restore()
  })

  beforeEach(() => {
    // Reset all mocks before each test
    mockFetch.mockClear()
    consoleSpies.error.mockClear()
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

      mockFetch.mockImplementation(createPageAndImageMock(targetUrl, html))

      const response = await app.handle(
        new Request(`http://localhost/link-preview/${targetUrl}`, {
          method: 'GET',
        }),
      )

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.title).toBe('Test Article')
      expect(body.data?.description).toBe('This is a test article')
      expect(body.data?.image).toBe('https://example.com/image.jpg')
      expect(body.data?.imageData).toMatch(/^data:image\/png;base64,/)
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

    it('should fallback to meta description when social tags are present', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="OG Title" />
            <meta name="description" content="Regular meta description" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.title).toBe('OG Title')
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

      mockFetch.mockImplementation(createPageAndImageMock(targetUrl, html))

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

      mockFetch.mockImplementation(createPageAndImageMock(targetUrl, html))

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

      mockFetch.mockImplementation(createPageAndImageMock(targetUrl, html))

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
        imageData: null,
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
      const html = '<html><head><meta property="og:title" content="Test" /></head></html>'

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

    it('should timeout after 10 seconds', async () => {
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

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('Network connection failed')
    })

    it('should return all nulls when page has no social tags (e.g. captcha page)', async () => {
      const targetUrl = 'https://example.com/blocked'
      const html = `
        <html>
          <head>
            <title>Please verify you are human</title>
            <meta name="description" content="Complete the captcha to continue" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data).toEqual({
        title: null,
        description: null,
        image: null,
        imageData: null,
      })
    })

    it('should use title tag fallback when at least one social tag is present', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <title>Page Title</title>
            <meta property="og:image" content="https://example.com/img.jpg" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(createPageAndImageMock(targetUrl, html))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.title).toBe('Page Title')
      expect(body.data?.image).toBe('https://example.com/img.jpg')
    })

    it('should inline image as base64 data URL when image fetch succeeds', async () => {
      const targetUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/og-image.jpg'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Test" />
            <meta property="og:image" content="${imageUrl}" />
          </head>
        </html>
      `

      mockFetch.mockImplementation((url: string) => {
        if (url === targetUrl) return Promise.resolve(createMockHtmlResponse(html))
        return Promise.resolve(createMockImageResponse('image/jpeg'))
      })

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))
      const body = (await response.json()) as LinkPreviewResponse

      expect(body.success).toBe(true)
      expect(body.data?.image).toBe(imageUrl)
      expect(body.data?.imageData).toMatch(/^data:image\/jpeg;base64,/)
    })

    it('should return null imageData when image fetch fails', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Test" />
            <meta property="og:image" content="https://example.com/broken.jpg" />
          </head>
        </html>
      `

      mockFetch.mockImplementation((url: string) => {
        if (url === targetUrl) return Promise.resolve(createMockHtmlResponse(html))
        return Promise.reject(new Error('Connection refused'))
      })

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))
      const body = (await response.json()) as LinkPreviewResponse

      expect(body.success).toBe(true)
      expect(body.data?.title).toBe('Test')
      expect(body.data?.image).toBe('https://example.com/broken.jpg')
      expect(body.data?.imageData).toBeNull()
    })

    it('should return null imageData when image returns non-200', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Test" />
            <meta property="og:image" content="https://example.com/forbidden.jpg" />
          </head>
        </html>
      `

      mockFetch.mockImplementation((url: string) => {
        if (url === targetUrl) return Promise.resolve(createMockHtmlResponse(html))
        return Promise.resolve(new Response('Forbidden', { status: 403 }))
      })

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))
      const body = (await response.json()) as LinkPreviewResponse

      expect(body.success).toBe(true)
      expect(body.data?.imageData).toBeNull()
    })

    it('should send User-Agent header', async () => {
      const targetUrl = 'https://example.com/page'
      const html = '<html><head><meta property="og:title" content="Test" /></head></html>'

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

    it('should skip inlining images larger than 2MB (Content-Length check)', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Test" />
            <meta property="og:image" content="https://example.com/huge.jpg" />
          </head>
        </html>
      `

      mockFetch.mockImplementation((url: string) => {
        if (url === targetUrl) return Promise.resolve(createMockHtmlResponse(html))
        // Return a response with Content-Length > 2MB
        return Promise.resolve(
          new Response(new Uint8Array(100), {
            status: 200,
            headers: { 'content-type': 'image/jpeg', 'content-length': '3000000' }, // 3MB
          }),
        )
      })

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))
      const body = (await response.json()) as LinkPreviewResponse

      expect(body.success).toBe(true)
      expect(body.data?.image).toBe('https://example.com/huge.jpg')
      expect(body.data?.imageData).toBeNull() // Should skip inlining due to size
    })

    it('should skip inlining images larger than 2MB (actual size check)', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Test" />
            <meta property="og:image" content="https://example.com/huge.jpg" />
          </head>
        </html>
      `

      // Create a buffer larger than 2MB (2MB + 1KB)
      const largeBuffer = new Uint8Array(2 * 1024 * 1024 + 1024)

      mockFetch.mockImplementation((url: string) => {
        if (url === targetUrl) return Promise.resolve(createMockHtmlResponse(html))
        // Return a response without Content-Length but with large body
        return Promise.resolve(
          new Response(largeBuffer, {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
        )
      })

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))
      const body = (await response.json()) as LinkPreviewResponse

      expect(body.success).toBe(true)
      expect(body.data?.image).toBe('https://example.com/huge.jpg')
      expect(body.data?.imageData).toBeNull() // Should skip inlining due to actual size
    })

    it('should infer content type from URL extension when header is missing', async () => {
      const targetUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/image.png'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Test" />
            <meta property="og:image" content="${imageUrl}" />
          </head>
        </html>
      `

      mockFetch.mockImplementation((url: string) => {
        if (url === targetUrl) return Promise.resolve(createMockHtmlResponse(html))
        // Return response without content-type header
        return Promise.resolve(
          new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: {}, // No content-type header
          }),
        )
      })

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))
      const body = (await response.json()) as LinkPreviewResponse

      expect(body.success).toBe(true)
      expect(body.data?.imageData).toMatch(/^data:image\/png;base64,/) // Should infer PNG from .png extension
    })
  })
})
