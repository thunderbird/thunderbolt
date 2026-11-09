/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient, HttpError, type HttpClient } from '@/lib/http'
import { nativeFetch } from '@/lib/native-fetch'

/** Empty MCP acknowledgments have no encrypted result for the SDK to decrypt. */
export class SearchAcknowledgment extends Error {
  constructor(readonly response: Response) {
    super('MCP request acknowledged without a result')
  }
}

/** Injects only HTTP delivery; SecureClient owns attestation, encryption, and decryption. */
export const createSearchNetworkFetch = (client: HttpClient): typeof fetch =>
  Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== 'https://websearch.tinfoil.sh' || url.pathname !== '/mcp' || url.username || url.password) {
        throw new Error('Tinfoil search refused an unexpected endpoint.')
      }
      const method = request.method === 'POST' ? 'post' : request.method === 'DELETE' ? 'delete' : null
      if (!method) {
        throw new Error('Tinfoil search refused an unsupported request method.')
      }
      if (method === 'post' && !request.headers.has('ehbp-encapsulated-key')) {
        throw new Error('Tinfoil search refused an unencrypted request.')
      }
      try {
        const response = await client[method](request.url, {
          headers: Object.fromEntries(request.headers),
          body: method === 'post' ? await request.arrayBuffer() : undefined,
          credentials: 'omit',
          redirect: 'error',
          signal: request.signal,
          timeout: 30_000,
        })
        if (method === 'delete' || response.status === 202) {
          // EHBP 0.5 requires a nonce for every 2xx response. Bypass decryption only
          // for these payload-free MCP responses, discarding any untrusted body.
          await response.body?.cancel()
          throw new SearchAcknowledgment(new Response(null, { status: response.status, headers: response.headers }))
        }
        return response
      } catch (error) {
        if (error instanceof HttpError) {
          return error.response
        }
        throw error
      }
    },
    { preconnect: globalThis.fetch.preconnect },
  )

export const nativeSearchClient = createClient({
  fetch: (input, init) => {
    const options: RequestInit = { ...init, redirect: 'error' }
    return nativeFetch(input, options)
  },
})

/** Relays only the encrypted envelope to the app host; never sends app cookies or follows redirects. */
export const createBrowserSearchClient = (
  origin: string,
  send: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
) =>
  createClient({
    fetch: async (input, init) => {
      const request = new Request(input, init)
      return send(
        new Request(new URL('/_tinfoil/search', origin), {
          method: request.method,
          headers: request.headers,
          body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
          signal: request.signal,
          credentials: 'omit',
          redirect: 'error',
        }),
      )
    },
  })
