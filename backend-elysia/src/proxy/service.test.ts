import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { ProxyService } from './service'
import type { ProxyContext } from './types'
import { createProxyConfig } from './types'

// Mock fetch globally
const mockFetch = spyOn(globalThis, 'fetch')

describe('Proxy Service', () => {
  let proxyService: ProxyService
  let mockContext: ProxyContext

  beforeEach(() => {
    mockFetch.mockReset()
    proxyService = new ProxyService()

    mockContext = {
      path: '/test',
      method: 'GET',
      headers: {
        'user-agent': 'test-agent',
        'content-type': 'application/json',
      },
      query: {},
      body: new Uint8Array(),
    } as any
  })

  describe('registerProxy', () => {
    it('should register a proxy configuration', () => {
      const config = createProxyConfig({
        targetUrl: 'https://api.example.com',
        apiKey: 'test-key',
      })

      proxyService.registerProxy('/test', config)

      const retrievedConfig = proxyService.getConfig('/test/endpoint')
      expect(retrievedConfig).toBe(config)
    })

    it('should allow multiple proxy registrations', () => {
      const config1 = createProxyConfig({ targetUrl: 'https://api1.example.com' })
      const config2 = createProxyConfig({ targetUrl: 'https://api2.example.com' })

      proxyService.registerProxy('/api1', config1)
      proxyService.registerProxy('/api2', config2)

      expect(proxyService.getConfig('/api1/endpoint')).toBe(config1)
      expect(proxyService.getConfig('/api2/endpoint')).toBe(config2)
    })
  })

  describe('getConfig', () => {
    beforeEach(() => {
      const config = createProxyConfig({
        targetUrl: 'https://api.example.com',
        apiKey: 'test-key',
      })
      proxyService.registerProxy('/test/api', config)
    })

    it('should return config for matching path prefix', () => {
      const config = proxyService.getConfig('/test/api/endpoint')
      expect(config).not.toBeNull()
      expect(config?.targetUrl).toBe('https://api.example.com')
    })

    it('should return null for non-matching path', () => {
      const config = proxyService.getConfig('/other/api/endpoint')
      expect(config).toBeNull()
    })

    it('should match longest prefix first', () => {
      const config1 = createProxyConfig({ targetUrl: 'https://api1.example.com' })
      const config2 = createProxyConfig({ targetUrl: 'https://api2.example.com' })

      proxyService.registerProxy('/api', config1)
      proxyService.registerProxy('/api/v2', config2)

      expect(proxyService.getConfig('/api/v2/endpoint')?.targetUrl).toBe('https://api2.example.com')
      expect(proxyService.getConfig('/api/v1/endpoint')?.targetUrl).toBe('https://api1.example.com')
    })
  })

  describe('verifyAuth', () => {
    it('should return true when authorization header exists', () => {
      mockContext.headers.authorization = 'Bearer test-token'
      expect(proxyService.verifyAuth(mockContext)).toBe(true)
    })

    it('should return false when authorization header is missing', () => {
      delete mockContext.headers.authorization
      expect(proxyService.verifyAuth(mockContext)).toBe(false)
    })

    it('should be case insensitive for header name', () => {
      mockContext.headers.Authorization = 'Bearer test-token'
      expect(proxyService.verifyAuth(mockContext)).toBe(true)
    })
  })

  describe('proxyRequest', () => {
    let config: ReturnType<typeof createProxyConfig>

    beforeEach(() => {
      config = createProxyConfig({
        targetUrl: 'https://api.example.com',
        apiKey: 'test-key',
        requireAuth: false,
      })
    })

    it('should make a basic proxy request', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]) as any,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      const response = await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(response.status).toBe(200)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/endpoint',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
        }),
      )
    })

    it('should add API key to Authorization header with Bearer prefix', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map() as any,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
        }),
      )
    })

    it('should not add Bearer prefix if API key already has it', async () => {
      config.apiKey = 'Bearer existing-bearer-token'

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map() as any,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer existing-bearer-token',
          }),
        }),
      )
    })

    it('should use custom API key header', async () => {
      config.apiKeyHeader = 'X-API-Key'

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map() as any,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'test-key',
          }),
        }),
      )
    })

    it('should add API key as query parameter when configured', async () => {
      config.apiKeyAsQueryParam = true
      config.apiKeyQueryParamName = 'api_key'

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map() as any,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/endpoint?api_key=test-key', expect.any(Object))
    })

    it('should handle query parameters correctly', async () => {
      mockContext.query = { search: 'test', limit: '10' }

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map() as any,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/endpoint?search=test&limit=10',
        expect.any(Object),
      )
    })

    it('should apply request transformer', async () => {
      const transformer = (body: Uint8Array) => {
        const text = new TextDecoder().decode(body)
        const data = JSON.parse(text)
        data.transformed = true
        return new TextEncoder().encode(JSON.stringify(data))
      }

      config.requestTransformer = transformer
      mockContext.body = new TextEncoder().encode(JSON.stringify({ test: true }))
      mockContext.method = 'POST'

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map() as any,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      await proxyService.proxyRequest(mockContext, 'endpoint', config)

      const expectedBodyString = JSON.stringify({ test: true, transformed: true })
      const expectedBody = new TextEncoder().encode(expectedBodyString)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expectedBody,
        }),
      )
    })

    it('should handle request transformer errors', async () => {
      const transformer = () => {
        throw new Error('Transformation failed')
      }

      config.requestTransformer = transformer
      mockContext.body = new TextEncoder().encode('{"test": true}')

      const response = await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(response.status).toBe(400)
      const responseText = await response.text()
      expect(responseText).toContain('Invalid request format')
    })

    it('should detect streaming request from Accept header', async () => {
      mockContext.headers.accept = 'text/event-stream'
      config.supportsStreaming = true

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'text/event-stream']]) as any,
        body: new ReadableStream(),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      const response = await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(response.body).toBeInstanceOf(ReadableStream)
    })

    it('should detect streaming request from JSON body', async () => {
      mockContext.method = 'POST'
      mockContext.body = new TextEncoder().encode(JSON.stringify({ stream: true }))
      config.supportsStreaming = true

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]) as any,
        body: new ReadableStream(),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      const response = await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(response.body).toBeInstanceOf(ReadableStream)
    })

    it('should handle network timeout errors', async () => {
      const timeoutError = new Error('Request timeout')
      timeoutError.name = 'TimeoutError'
      mockFetch.mockRejectedValueOnce(timeoutError)

      const response = await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(response.status).toBe(504)
      const responseData = await response.json()
      expect(responseData.error).toBe('Gateway timeout')
    })

    it('should handle general network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const response = await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(response.status).toBe(502)
      const responseData = await response.json()
      expect(responseData.error).toBe('Bad gateway')
    })

    it('should strip headers specified in config', async () => {
      config.stripHeaders = new Set(['x-custom-header'])
      mockContext.headers['x-custom-header'] = 'should-be-removed'
      mockContext.headers['x-keep-header'] = 'should-be-kept'

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map() as any,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.not.objectContaining({
            'x-custom-header': 'should-be-removed',
          }),
        }),
      )

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-keep-header': 'should-be-kept',
          }),
        }),
      )
    })

    it('should add Flower SDK headers for Flower API', async () => {
      config.targetUrl = 'https://api.flower.ai'

      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map() as any,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Flower-SDK-Version': '0.1.8',
            'X-Flower-SDK-Language': 'TS',
            'User-Agent': 'Flower-Intelligence-SDK/0.1.8 (TS)',
          }),
        }),
      )
    })

    it('should handle special Fireworks error responses', async () => {
      config.targetUrl = 'https://api.fireworks.ai'

      const errorBody = JSON.stringify({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Internal server error',
        },
      })

      const mockResponse = {
        status: 500,
        headers: new Map([['content-type', 'application/json']]) as any,
        arrayBuffer: async () => new TextEncoder().encode(errorBody).buffer,
      }
      mockFetch.mockResolvedValueOnce(mockResponse as Response)

      const response = await proxyService.proxyRequest(mockContext, 'endpoint', config)

      expect(response.status).toBe(503)
      const responseData = await response.json()
      expect(responseData.error.code).toBe('SERVICE_UNAVAILABLE')
      expect(responseData.error.message).toContain('AI service is temporarily offline')
    })
  })

  describe('close', () => {
    it('should close without errors', async () => {
      await expect(proxyService.close()).resolves.toBeUndefined()
    })
  })
})
