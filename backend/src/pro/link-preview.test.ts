/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { createLinkPreviewRoutes } from './link-preview'
import type { LinkPreviewResponse } from './types'
import * as settingsModule from '@/config/settings'

// Mock DNS — external Node API, acceptable per docs/testing.md "When You Must Mock"
const mockDnsLookup = mock(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
mock.module('node:dns', () => ({ promises: { lookup: mockDnsLookup } }))
mock.module('node:net', () => ({ isIP: (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : 0) }))

describe('Link Preview Routes', () => {
  let app: { handle: Elysia['handle'] }
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
    mockDnsLookup.mockClear()
    mockDnsLookup.mockImplementation(() => Promise.resolve([{ address: '93.184.216.34', family: 4 }]))
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

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

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
        siteName: null,
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
      expect(body.error).toBe('Invalid URL')
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

    it('should block private IPs on metadata endpoint (SSRF protection)', async () => {
      const privateIps = ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/']

      for (const privateUrl of privateIps) {
        const encoded = encodeURIComponent(privateUrl)
        const response = await app.handle(new Request(`http://localhost/link-preview/${encoded}`, { method: 'GET' }))

        expect(response.status).toBe(200)
        expect(mockFetch).not.toHaveBeenCalled()

        const body = (await response.json()) as LinkPreviewResponse
        expect(body.success).toBe(false)
        expect(body.error).toBe('Internal URLs are not allowed')
      }
    })

    it('should block localhost on metadata endpoint (SSRF protection)', async () => {
      const encoded = encodeURIComponent('http://localhost/admin')
      const response = await app.handle(new Request(`http://localhost/link-preview/${encoded}`, { method: 'GET' }))

      expect(response.status).toBe(200)
      expect(mockFetch).not.toHaveBeenCalled()

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('Internal URLs are not allowed')
    })

    it('should return error when HTML response exceeds size limit', async () => {
      const largeHtml = 'x'.repeat(3 * 1024 * 1024) // 3MB — exceeds 2MB limit
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(largeHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
      )

      const encoded = encodeURIComponent('https://example.com')
      const response = await app.handle(new Request(`http://localhost/link-preview/${encoded}`, { method: 'GET' }))

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('Response too large')
    })

    it('should reject when Content-Length exceeds size limit', async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response('small body', {
            status: 200,
            headers: { 'Content-Type': 'text/html', 'Content-Length': String(5 * 1024 * 1024) },
          }),
        ),
      )

      const encoded = encodeURIComponent('https://example.com')
      const response = await app.handle(new Request(`http://localhost/link-preview/${encoded}`, { method: 'GET' }))

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(false)
      expect(body.error).toBe('Response too large')
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
      expect(mockFetch).toHaveBeenCalledTimes(1)

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
      expect(mockFetch).toHaveBeenCalledTimes(1)

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
      expect(body.error).toBe('Link preview request failed')
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
        siteName: null,
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

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.title).toBe('Page Title')
      expect(body.data?.image).toBe('https://example.com/img.jpg')
    })

    it('should extract og:site_name', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Article Title" />
            <meta property="og:site_name" content="The Example Times" />
            <meta property="og:description" content="An article" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.siteName).toBe('The Example Times')
      expect(body.data?.title).toBe('Article Title')
    })

    it('should return null siteName when og:site_name is not present', async () => {
      const targetUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <meta property="og:title" content="Article Title" />
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(response.status).toBe(200)

      const body = (await response.json()) as LinkPreviewResponse
      expect(body.success).toBe(true)
      expect(body.data?.siteName).toBeNull()
    })

    it('should send User-Agent header', async () => {
      const targetUrl = 'https://example.com/page'
      const html = '<html><head><meta property="og:title" content="Test" /></head></html>'

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      await app.handle(new Request(`http://localhost/link-preview/${targetUrl}`, { method: 'GET' }))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, calledInit] = mockFetch.mock.calls[0]
      const headers = calledInit.headers as Headers
      expect(headers.get('User-Agent')).toBe(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      )
      expect(headers.get('Accept')).toBe('text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8')
      expect(headers.get('Accept-Language')).toBe('en-US,en;q=0.9')
      expect(headers.get('Host')).toBe('example.com')
    })
  })

  describe('GET /link-preview/image/*', () => {
    const createMockImageResponse = (contentType = 'image/png', size = 100) =>
      new Response(new Uint8Array(size), {
        status: 200,
        headers: { 'content-type': contentType },
      })

    it('should fetch page, extract image URL, and return image with proper content type', async () => {
      const pageUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/image.jpg'
      const html = `
        <html>
          <head>
            <meta property="og:image" content="${imageUrl}" />
          </head>
        </html>
      `

      // Mock: first call fetches page, second call fetches image
      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(createMockHtmlResponse(html))
        }
        return Promise.resolve(createMockImageResponse('image/jpeg'))
      })

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/jpeg')
      const buffer = await response.arrayBuffer()
      expect(buffer.byteLength).toBe(100)
    })

    it('should infer content type from URL extension when header is missing', async () => {
      const pageUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/image.png'
      const html = `
        <html>
          <head>
            <meta property="og:image" content="${imageUrl}" />
          </head>
        </html>
      `

      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(createMockHtmlResponse(html))
        }
        return Promise.resolve(
          new Response(new Uint8Array(100), {
            status: 200,
            headers: {}, // No content-type header
          }),
        )
      })

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
    })

    it('should reject HTML page response exceeding 2MB (Content-Length check)', async () => {
      const pageUrl = 'https://example.com/page'

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response('small body', {
            status: 200,
            headers: { 'Content-Type': 'text/html', 'Content-Length': String(5 * 1024 * 1024) },
          }),
        ),
      )

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(413)
      expect(await response.text()).toBe('Page response too large')
    })

    it('should reject HTML page response exceeding 2MB (actual size check)', async () => {
      const pageUrl = 'https://example.com/page'
      const largeHtml = 'x'.repeat(3 * 1024 * 1024) // 3MB — exceeds 2MB limit

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(largeHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
      )

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(413)
      expect(await response.text()).toBe('Page response too large')
    })

    it('should reject images larger than 2MB (Content-Length check)', async () => {
      const pageUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/huge.jpg'
      const html = `
        <html>
          <head>
            <meta property="og:image" content="${imageUrl}" />
          </head>
        </html>
      `

      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(createMockHtmlResponse(html))
        }
        return Promise.resolve(
          new Response(new Uint8Array(100), {
            status: 200,
            headers: { 'content-type': 'image/jpeg', 'content-length': '3000000' }, // 3MB
          }),
        )
      })

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(413)
      expect(await response.text()).toBe('Image too large')
    })

    it('should reject images larger than 2MB (actual size check)', async () => {
      const pageUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/huge.jpg'
      const html = `
        <html>
          <head>
            <meta property="og:image" content="${imageUrl}" />
          </head>
        </html>
      `
      const largeBuffer = new Uint8Array(2 * 1024 * 1024 + 1024) // 2MB + 1KB

      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(createMockHtmlResponse(html))
        }
        return Promise.resolve(
          new Response(largeBuffer, {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
        )
      })

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(413)
      expect(await response.text()).toBe('Image too large')
    })

    it('should timeout after 2 seconds when image fetch is slow', async () => {
      const pageUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/slow.jpg'
      const html = `
        <html>
          <head>
            <meta property="og:image" content="${imageUrl}" />
          </head>
        </html>
      `

      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(createMockHtmlResponse(html))
        }
        // Simulate abort - when the abort controller fires after 2s, fetch rejects with AbortError
        const abortError = new Error('The operation was aborted')
        abortError.name = 'AbortError'
        return Promise.reject(abortError)
      })

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(408)
      expect(await response.text()).toBe('Image fetch timeout')
    })

    it('should return 400 for invalid URL encoding', async () => {
      const response = await app.handle(new Request('http://localhost/link-preview/image/%E0%A4%A', { method: 'GET' }))

      expect(response.status).toBe(400)
      expect(await response.text()).toBe('Invalid URL encoding')
    })

    it('should return 400 for non-HTTP(S) URLs', async () => {
      const pageUrl = 'file:///etc/passwd'
      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(400)
      expect(await response.text()).toBe('Only HTTP and HTTPS URLs are supported')
    })

    it('should return 500 on image fetch failure', async () => {
      const pageUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/broken.jpg'
      const html = `
        <html>
          <head>
            <meta property="og:image" content="${imageUrl}" />
          </head>
        </html>
      `

      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(createMockHtmlResponse(html))
        }
        return Promise.reject(new Error('Connection refused'))
      })

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(500)
      expect(await response.text()).toBe('Image fetch failed')
    })

    it('should return error status when image fetch returns non-200', async () => {
      const pageUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/forbidden.jpg'
      const html = `
        <html>
          <head>
            <meta property="og:image" content="${imageUrl}" />
          </head>
        </html>
      `

      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(createMockHtmlResponse(html))
        }
        return Promise.resolve(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }))
      })

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(403)
      expect(await response.text()).toBe('Failed to fetch image: Forbidden')
    })

    it('should return 404 when page has no image', async () => {
      const pageUrl = 'https://example.com/page'
      const html = `
        <html>
          <head>
            <title>Page without image</title>
          </head>
        </html>
      `

      mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(404)
      expect(await response.text()).toBe('No image found in page metadata')
    })

    it('should return 408 when page fetch times out', async () => {
      const pageUrl = 'https://example.com/slow-page'
      const abortError = new Error('The operation was aborted')
      abortError.name = 'AbortError'
      mockFetch.mockImplementation(() => Promise.reject(abortError))

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(408)
      expect(await response.text()).toBe('Request timeout exceeded')
    })

    describe('SSRF protection', () => {
      it('should reject file:// protocol in image URL', async () => {
        const pageUrl = 'https://example.com/page'
        const html = `
          <html>
            <head>
              <meta property="og:image" content="file:///etc/passwd" />
            </head>
          </html>
        `

        mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

        const response = await app.handle(
          new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
        )

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Only HTTP and HTTPS URLs are supported')
      })

      it('should reject localhost in image URL', async () => {
        const pageUrl = 'https://example.com/page'
        const html = `
          <html>
            <head>
              <meta property="og:image" content="http://localhost/admin" />
            </head>
          </html>
        `

        mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

        const response = await app.handle(
          new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
        )

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Internal URLs are not allowed')
      })

      it('should reject 127.0.0.1 in image URL', async () => {
        const pageUrl = 'https://example.com/page'
        const html = `
          <html>
            <head>
              <meta property="og:image" content="http://127.0.0.1/admin" />
            </head>
          </html>
        `

        mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

        const response = await app.handle(
          new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
        )

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Internal URLs are not allowed')
      })

      it('should reject private IP ranges (10.x.x.x) in image URL', async () => {
        const pageUrl = 'https://example.com/page'
        const html = `
          <html>
            <head>
              <meta property="og:image" content="http://10.0.0.1/admin" />
            </head>
          </html>
        `

        mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

        const response = await app.handle(
          new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
        )

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Internal URLs are not allowed')
      })

      it('should reject private IP ranges (172.16.x.x) in image URL', async () => {
        const pageUrl = 'https://example.com/page'
        const html = `
          <html>
            <head>
              <meta property="og:image" content="http://172.16.0.1/admin" />
            </head>
          </html>
        `

        mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

        const response = await app.handle(
          new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
        )

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Internal URLs are not allowed')
      })

      it('should reject private IP ranges (192.168.x.x) in image URL', async () => {
        const pageUrl = 'https://example.com/page'
        const html = `
          <html>
            <head>
              <meta property="og:image" content="http://192.168.1.1/admin" />
            </head>
          </html>
        `

        mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

        const response = await app.handle(
          new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
        )

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Internal URLs are not allowed')
      })

      it('should reject cloud metadata endpoint (169.254.169.254) in image URL', async () => {
        const pageUrl = 'https://example.com/page'
        const html = `
          <html>
            <head>
              <meta property="og:image" content="http://169.254.169.254/latest/meta-data/" />
            </head>
          </html>
        `

        mockFetch.mockImplementation(() => Promise.resolve(createMockHtmlResponse(html)))

        const response = await app.handle(
          new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
        )

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Internal URLs are not allowed')
      })

      it('should allow valid external image URLs', async () => {
        const pageUrl = 'https://example.com/page'
        const imageUrl = 'https://example.com/image.jpg'
        const html = `
          <html>
            <head>
              <meta property="og:image" content="${imageUrl}" />
            </head>
          </html>
        `

        let callCount = 0
        mockFetch.mockImplementation(() => {
          callCount++
          if (callCount === 1) {
            return Promise.resolve(createMockHtmlResponse(html))
          }
          return Promise.resolve(createMockImageResponse('image/jpeg'))
        })

        const response = await app.handle(
          new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
        )

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/jpeg')
      })
    })

    it('should add security headers to prevent XSS via proxied content', async () => {
      const pageUrl = 'https://example.com/page'
      const imageUrl = 'https://example.com/image.png'
      const html = `<html><head><meta property="og:image" content="${imageUrl}" /></head></html>`

      let callCount = 0
      mockFetch.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve(createMockHtmlResponse(html))
        }
        return Promise.resolve(createMockImageResponse('image/png'))
      })

      const response = await app.handle(
        new Request(`http://localhost/link-preview/image/${pageUrl}`, { method: 'GET' }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toBe('sandbox')
      expect(response.headers.get('content-disposition')).toBeNull()
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    })
  })
})
