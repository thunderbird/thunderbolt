import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

/**
 * Custom fetch wrapper that uses Tauri's HTTP client to bypass CORS
 */
export const createTauriFetch = (): typeof fetch =>
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString()

      // Use Tauri's fetch which bypasses CORS
      return tauriFetch(url, init || {})
    },
    {
      preconnect: () => Promise.resolve(false),
    },
  )

/**
 * Custom transport that uses Tauri's HTTP client
 */
export class TauriStreamableHTTPClientTransport extends StreamableHTTPClientTransport {
  constructor(url: URL, options?: any) {
    // Override global fetch temporarily during construction
    const originalFetch = globalThis.fetch
    globalThis.fetch = createTauriFetch()

    try {
      super(url, options)
    } finally {
      globalThis.fetch = originalFetch
    }

    // Override the internal fetch method if possible
    // This is a workaround since the SDK doesn't expose a way to inject custom fetch
    const transport = this as any
    if (transport._fetch || transport.fetch) {
      const fetchProp = transport._fetch ? '_fetch' : 'fetch'
      transport[fetchProp] = createTauriFetch()
    }
  }
}
