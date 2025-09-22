import type { ProxyConfig, ProxyContext } from './types'

/**
 * Service to handle proxying requests to external APIs
 */
export class ProxyService {
  private configs = new Map<string, ProxyConfig>()

  /**
   * Register a new proxy configuration for a path prefix
   */
  registerProxy(pathPrefix: string, config: ProxyConfig): void {
    this.configs.set(pathPrefix, config)
  }

  /**
   * Get the proxy configuration for a given path
   */
  getConfig(path: string): ProxyConfig | null {
    for (const [prefix, config] of this.configs) {
      if (path.startsWith(prefix)) {
        return config
      }
    }
    return null
  }

  /**
   * Verify the request has proper authentication
   */
  verifyAuth(ctx: ProxyContext): boolean {
    // For now, just check if Authorization header exists
    return 'authorization' in ctx.headers
  }

  /**
   * Prepare headers for the proxied request
   */
  private prepareHeaders(ctx: ProxyContext, config: ProxyConfig): Record<string, string> {
    const headers: Record<string, string> = {}

    // Copy headers except the ones we want to strip
    for (const [key, value] of Object.entries(ctx.headers)) {
      if (!config.stripHeaders.has(key.toLowerCase())) {
        headers[key] = value
      }
    }

    // Add API key as header if configured and not using query param mode
    if (config.apiKey && !config.apiKeyAsQueryParam) {
      // Special handling for Authorization header - add Bearer prefix if needed
      if (config.apiKeyHeader.toLowerCase() === 'authorization' && !config.apiKey.startsWith('Bearer ')) {
        headers[config.apiKeyHeader] = `Bearer ${config.apiKey}`
      } else {
        headers[config.apiKeyHeader] = config.apiKey
      }
    }

    // Add SDK headers for Flower AI
    if (config.targetUrl.toLowerCase().includes('flower')) {
      headers['X-Flower-SDK-Version'] = '0.1.8'
      headers['X-Flower-SDK-Language'] = 'TS'
      headers['User-Agent'] = 'Flower-Intelligence-SDK/0.1.8 (TS)'
    }

    // Remove host header as it will be set by fetch
    delete headers.host
    delete headers['content-length']

    return headers
  }

  /**
   * Process and clean query parameters
   */
  private processQueryParams(ctx: ProxyContext, config: ProxyConfig): Record<string, string> {
    const queryParams: Record<string, string> = {}

    // Convert query parameters to flat object
    for (const [key, value] of Object.entries(ctx.query)) {
      if (!config.stripQueryParams.has(key)) {
        queryParams[key] = Array.isArray(value) ? value[0] : value
      }
    }

    // Add API key as query parameter if configured
    if (config.apiKey && config.apiKeyAsQueryParam) {
      queryParams[config.apiKeyQueryParamName] = config.apiKey
    }

    return queryParams
  }

  /**
   * Build target URL with query parameters
   */
  private buildTargetUrl(ctx: ProxyContext, config: ProxyConfig, path: string): string {
    let targetUrl = `${config.targetUrl}/${path}`

    const queryParams = this.processQueryParams(ctx, config)
    const queryString = new URLSearchParams(queryParams).toString()

    if (queryString) {
      targetUrl += `?${queryString}`
    }

    return targetUrl
  }

  /**
   * Check if this is a streaming request
   */
  private isStreamingRequest(ctx: ProxyContext, body: Uint8Array): boolean {
    const contentType = ctx.headers['content-type'] || ''
    const accept = ctx.headers.accept || ''

    // Check for streaming indicators
    if (accept.includes('text/event-stream')) {
      return true
    }

    // Parse request body to check for stream parameter
    if (ctx.method === 'POST' && contentType.includes('application/json') && body.length > 0) {
      try {
        const bodyText = new TextDecoder().decode(body)
        const bodyJson = JSON.parse(bodyText)
        return bodyJson.stream === true
      } catch {
        // Ignore parsing errors
      }
    }

    return false
  }

  /**
   * Proxy a request to the configured target
   */
  async proxyRequest(ctx: ProxyContext, path: string, config: ProxyConfig): Promise<Response> {
    // Apply request transformer if configured
    let body = ctx.body
    if (config.requestTransformer && body.length > 0) {
      try {
        body = config.requestTransformer(body)
      } catch (error) {
        console.error('Request transformation failed:', error)
        return new Response(JSON.stringify({ error: 'Invalid request format' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
    }

    // Check if this is a streaming request
    const isStreaming = config.supportsStreaming && this.isStreamingRequest(ctx, body)

    // Build target URL
    const targetUrl = this.buildTargetUrl(ctx, config, path)

    // Prepare headers
    const headers = this.prepareHeaders(ctx, config)

    try {
      // Make the proxied request
      const response = await fetch(targetUrl, {
        method: ctx.method,
        headers,
        body: body.length > 0 ? (body as BodyInit) : null,
      })

      if (isStreaming) {
        return this.handleStreamingResponse(response)
      } else {
        return this.handleBufferedResponse(response, config)
      }
    } catch (error) {
      console.error('Proxy request failed:', error)

      if (error instanceof Error) {
        if (error.name === 'TimeoutError') {
          return new Response(JSON.stringify({ error: 'Gateway timeout' }), {
            status: 504,
            headers: { 'content-type': 'application/json' },
          })
        }
      }

      return new Response(JSON.stringify({ error: 'Bad gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    }
  }

  /**
   * Handle streaming responses
   */
  private handleStreamingResponse(response: Response): Response {
    // Clean response headers - remove hop-by-hop headers and upstream CORS headers
    const hopByHopHeaders = new Set([
      'transfer-encoding',
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailers',
      'upgrade',
      'content-length',
      'cross-origin-resource-policy',
      'cross-origin-embedder-policy',
      'cross-origin-opener-policy',
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-allow-credentials',
      'access-control-expose-headers',
      'access-control-max-age',
    ])

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      if (!hopByHopHeaders.has(key.toLowerCase())) {
        responseHeaders[key] = value
      }
    })

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  }

  /**
   * Handle buffered responses with full response processing
   */
  private async handleBufferedResponse(response: Response, config: ProxyConfig): Promise<Response> {
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    // Remove problematic CORS headers and upstream CORS headers to prevent conflicts
    const problematicHeaders = [
      'cross-origin-resource-policy',
      'cross-origin-embedder-policy',
      'cross-origin-opener-policy',
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-allow-credentials',
      'access-control-expose-headers',
      'access-control-max-age',
    ]
    problematicHeaders.forEach((header) => {
      delete responseHeaders[header]
    })

    // Get response content
    const content = await response.arrayBuffer()
    const contentUint8 = new Uint8Array(content)

    // Handle decompression if needed (Bun handles this automatically in most cases)
    delete responseHeaders['content-encoding']
    delete responseHeaders['transfer-encoding']
    delete responseHeaders['vary']

    // Special handling for JSON responses
    const contentType = responseHeaders['content-type'] || 'application/octet-stream'
    let finalContent = contentUint8

    if (contentType.toLowerCase().includes('application/json')) {
      try {
        const jsonStr = new TextDecoder().decode(contentUint8)
        const parsedJson = JSON.parse(jsonStr)
        finalContent = new TextEncoder().encode(JSON.stringify(parsedJson))
        responseHeaders['content-type'] = 'application/json; charset=utf-8'
      } catch (error) {
        console.error('Error processing JSON content:', error)
      }
    }

    // Set the correct content length
    responseHeaders['content-length'] = finalContent.length.toString()

    // Handle specific error cases for Fireworks
    if (response.status === 500 && config.targetUrl.includes('fireworks')) {
      try {
        const errorJson = JSON.parse(new TextDecoder().decode(finalContent))
        if (errorJson.error?.code === 'INTERNAL_SERVER_ERROR') {
          const errorResponse = {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'AI service is temporarily offline. Please try again later.',
              type: 'service_error',
            },
          }
          finalContent = new TextEncoder().encode(JSON.stringify(errorResponse))
          responseHeaders['content-length'] = finalContent.length.toString()
          return new Response(finalContent, {
            status: 503,
            headers: responseHeaders,
          })
        }
      } catch {
        // Ignore parsing errors
      }
    }

    return new Response(finalContent, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  }

  /**
   * Close the service (cleanup)
   */
  async close(): Promise<void> {
    // No cleanup needed for fetch-based implementation
  }
}

// Global proxy service instance
export const proxyService = new ProxyService()
