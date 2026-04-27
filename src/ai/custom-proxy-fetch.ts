import type { HttpClient } from '@/lib/http'
import type { CustomModelProxyRequest } from 'shared/custom-model-proxy'
import { isLocalhostUrl } from './is-localhost-url'
import { isTauri } from '@/lib/platform'

type CreateCustomProxyFetchOpts = {
  /** User's custom endpoint base URL (e.g. "https://animal.inference.thunderbolt.io/v1"). */
  baseURL: string
  /** User's API key for the upstream. Moved into body for cloud routing. */
  upstreamAuth?: string
  /** Authenticated Thunderbolt backend client. */
  httpClient: HttpClient
  /**
   * Optional Tauri fetch override. Only used to inject a spy in tests.
   * In production, left undefined so the runtime lazy-imports `@/lib/fetch`.
   */
  tauriFetch?: typeof fetch
}

/**
 * Returns a `fetch`-compatible function bound to a specific custom model endpoint.
 *
 * Routing logic:
 * 1. Tauri runtime → delegate to `src/lib/fetch.ts` (Tauri native-fetch path, unchanged).
 * 2. Web + localhost/loopback `baseURL` → `globalThis.fetch` directly (CORS carve-out).
 * 3. Web + cloud `baseURL` → POST to `/v1/custom-model/proxy` via the authenticated
 *    Thunderbolt backend client; `upstreamAuth` travels in the request body only,
 *    never as an `Authorization` header in the browser→backend leg.
 *
 * The returned function is passed directly to `createOpenAICompatible({ fetch: ... })`.
 * The Vercel AI SDK will invoke it with the full target URL (e.g. `${baseURL}/chat/completions`)
 * and a `RequestInit` whose body is the JSON-encoded chat completion request.
 */
export const createCustomProxyFetch = (opts: CreateCustomProxyFetchOpts): typeof fetch => {
  const { baseURL, upstreamAuth, httpClient, tauriFetch } = opts

  const proxyFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Tauri path — delegate unchanged so Tauri native-fetch transport is preserved (US-003).
    // Lazy import avoids loading src/lib/fetch.ts (which calls getDb()) at module init time.
    if (isTauri()) {
      const fn = tauriFetch ?? (await import('@/lib/fetch')).fetch
      return fn(input, init)
    }

    // Localhost / loopback — CORS carve-out; backend cannot reach user's localhost anyway.
    if (isLocalhostUrl(baseURL)) {
      return globalThis.fetch(input, init)
    }

    const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    // Parse the body from the SDK's RequestInit.
    // The Vercel AI SDK always provides a JSON string or ReadableStream body.
    let parsedBody: unknown
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') {
        parsedBody = JSON.parse(init.body)
      } else {
        // ReadableStream / ArrayBuffer / Blob — normalise to string via Response helper.
        const text = await new Response(init.body).text()
        parsedBody = JSON.parse(text)
      }
    }

    // Detect streaming intent: body.stream === true OR Accept header is text/event-stream.
    const bodyStream = (parsedBody as Record<string, unknown> | undefined)?.stream === true
    const acceptHeader =
      init?.headers instanceof Headers
        ? init.headers.get('accept')
        : typeof init?.headers === 'object' && init?.headers !== null
          ? ((init.headers as Record<string, string>)['accept'] ?? (init.headers as Record<string, string>)['Accept'])
          : undefined
    const isStream = bodyStream || (typeof acceptHeader === 'string' && acceptHeader.includes('text/event-stream'))

    const proxyRequest: CustomModelProxyRequest = {
      targetUrl: inputUrl,
      upstreamAuth: upstreamAuth || undefined,
      body: parsedBody,
      method: 'POST',
      stream: isStream,
    }

    // Forward the AbortSignal from the AI SDK so in-flight requests can be cancelled.
    const signal = init?.signal ?? undefined

    return httpClient.post('custom-model/proxy', {
      json: proxyRequest,
      signal,
    })
  }

  // Bun's `fetch` type expects a `preconnect` method.
  proxyFetch.preconnect = () => Promise.resolve(false)

  return proxyFetch
}
