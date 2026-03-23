import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import { createTauriFetch } from './tauri-http-transport'

/**
 * Creates an SSE MCP transport that uses Tauri's native HTTP client for CORS
 * bypass on external MCP server URLs.
 *
 * SSE transport is the legacy predecessor to Streamable HTTP. Some older MCP
 * servers still use it.
 */
export const createTauriSseTransport = (url: URL, options?: SSEClientTransportOptions): SSEClientTransport =>
  new SSEClientTransport(url, {
    ...options,
    fetch: createTauriFetch(),
  })
