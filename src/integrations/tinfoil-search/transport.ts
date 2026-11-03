/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { isTauri } from '@/lib/platform'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createTinfoilClientLifecycle, isTinfoilTransportWedgedError } from '@/ai/tinfoil-client'
import { getUserCacheSecret } from '@/lib/auth-token'

const lifecycle = createTinfoilClientLifecycle({
  createClient: async () => {
    // Keep the attestation SDK cold until an agent actually invokes a web tool.
    const { SecureClient } = await import('tinfoil')
    return new SecureClient({
      enclaveURL: 'https://websearch.tinfoil.sh',
      configRepo: 'tinfoilsh/confidential-websearch',
      userCacheSecret: getUserCacheSecret(),
    })
  },
  getCloudUrl: () => '',
})

export type TinfoilToolResult = {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: Array<{ type: string; text?: string }>
}
export type TinfoilToolCaller = (name: 'search' | 'fetch', args: Record<string, unknown>) => Promise<TinfoilToolResult>

type TransportDependencies = {
  acquire: () => Promise<{
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    getBaseURL: () => string | undefined
  }>
  evict: () => void
}
const transportDependencies: TransportDependencies = {
  acquire: async () => {
    const secure = await lifecycle.getTinfoilClient()
    const [{ createAttestedSearchFetch }, { nativeSearchClient, createBrowserSearchClient }] = await Promise.all([
      import('./attested-fetch'),
      import('./http-client'),
    ])
    const client = isTauri() ? nativeSearchClient : createBrowserSearchClient(window.location.origin)
    return {
      fetch: await createAttestedSearchFetch(secure.getVerificationDocument(), client),
      getBaseURL: () => secure.getBaseURL(),
    }
  },
  evict: lifecycle.evictUserTinfoilClient,
}

/** Uses MCP framing over an attested encrypted transport, refreshing authorization per request. */
export const createTinfoilToolCaller =
  (getApiKey: () => Promise<string>, deps = transportDependencies): TinfoilToolCaller =>
  async (name, args) => {
    const secure = await deps.acquire()
    const endpoint = new URL('/mcp', secure.getBaseURL())
    const client = new Client({ name: 'thunderbolt-web-search', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set('Authorization', `Bearer ${await getApiKey()}`)
        headers.set('X-Tinfoil-Tool-PII-Check', 'true')
        headers.set('X-Tinfoil-Tool-Injection-Check', 'true')
        return secure.fetch(input, { ...init, headers, credentials: 'omit' })
      },
    })
    try {
      await client.connect(transport, { timeout: 30_000 })
      return CallToolResultSchema.parse(
        await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 30_000 }),
      )
    } catch (error) {
      if (isTinfoilTransportWedgedError(error)) {
        deps.evict()
      }
      throw error
    } finally {
      await client.close()
    }
  }
