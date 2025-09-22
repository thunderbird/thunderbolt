import type { Context } from 'elysia'

/**
 * Configuration for a specific proxy endpoint
 */
export interface ProxyConfig {
  targetUrl: string
  apiKey: string
  apiKeyHeader: string
  apiKeyAsQueryParam: boolean
  apiKeyQueryParamName: string
  stripHeaders: Set<string>
  stripQueryParams: Set<string>
  requireAuth: boolean
  supportsStreaming: boolean
  requestTransformer?: (body: Uint8Array) => Uint8Array
}

/**
 * Default proxy configuration
 */
export const createProxyConfig = (options: Partial<ProxyConfig> & { targetUrl: string }): ProxyConfig => ({
  targetUrl: options.targetUrl.replace(/\/$/, ''),
  apiKey: options.apiKey || '',
  apiKeyHeader: options.apiKeyHeader || 'Authorization',
  apiKeyAsQueryParam: options.apiKeyAsQueryParam || false,
  apiKeyQueryParamName: options.apiKeyQueryParamName || 'key',
  stripHeaders: options.stripHeaders || new Set(),
  stripQueryParams: options.stripQueryParams || new Set(),
  requireAuth: options.requireAuth !== undefined ? options.requireAuth : true,
  supportsStreaming: options.supportsStreaming || false,
  requestTransformer: options.requestTransformer,
})

/**
 * Proxy response interface
 */
export interface ProxyResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array | ReadableStream<Uint8Array>
  isStream: boolean
}

/**
 * Request context with proxy-specific data
 */
export interface ProxyContext extends Context {
  path: string
  method: string
  headers: Record<string, string>
  query: Record<string, string>
  body: Uint8Array
}
