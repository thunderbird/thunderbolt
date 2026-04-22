/**
 * Custom-model proxy routes.
 *
 * POST /v1/custom-model/proxy  — streaming chat completions via OpenAI SDK
 * POST /v1/custom-model/models — upstream model discovery via direct fetch
 *
 * Security invariants (all enforced by code + test):
 * - SSRF defense delegated entirely to createSafeFetch (url-validation.ts).
 * - upstreamAuth validated against ^[\x20-\x7E]+$ (CRLF/header-injection defense).
 * - Per-user rate limit (60 req/min, RateLimiterMemory).
 * - Authorization/upstreamAuth never logged (not present in audit entry type).
 * - Mandatory outbound headers: User-Agent + X-Abuse-Contact.
 * - Content-Type gate: application/json or text/event-stream only.
 * - 101 Switching Protocols → 502.
 * - Body cap: 50 MB total.
 */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { createSafeFetch, validateSafeUrl } from '@/utils/url-validation'
import { Elysia } from 'elysia'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import type { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions'
import type { CustomModelModelsRequest, CustomModelProxyRequest, ProxyErrorEnvelope } from '@shared/custom-model-proxy'
import { getCustomModelClient } from './client'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_BYTES = 52_428_800 // 50 MB
const REQUEST_TIMEOUT_MS = 300_000 // 5 min
const RATE_LIMIT_USER = 60 // per minute
const USER_AGENT = 'Thunderbolt-Proxy/1.0'
const ABUSE_CONTACT = 'abuse@thunderbolt.io'

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

// IMPORTANT: RateLimiterMemory is single-instance only. If the backend scales
// to multiple instances, switch to RateLimiterPostgres.
export const perUserLimiter = new RateLimiterMemory({
  keyPrefix: 'custom-proxy-user',
  points: RATE_LIMIT_USER,
  duration: 60,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const proxyError = (code: ProxyErrorEnvelope['error']['code'], message: string, httpStatus: number): Response =>
  new Response(JSON.stringify({ error: { code, message, httpStatus } } satisfies ProxyErrorEnvelope), {
    status: httpStatus,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const isPrintableAscii = (value: string): boolean => /^[\x20-\x7E]+$/.test(value)

const ALLOWED_CONTENT_TYPES = ['application/json', 'text/event-stream']

const isAllowedContentType = (contentType: string | null): boolean => {
  if (!contentType) return false
  const mime = contentType.split(';')[0].trim().toLowerCase()
  return ALLOWED_CONTENT_TYPES.includes(mime)
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'set-cookie',
])

const stripHopByHop = (headers: Headers): Headers => {
  const out = new Headers(headers)
  for (const key of HOP_BY_HOP) out.delete(key)
  return out
}

class ProxyRequestError extends Error {
  constructor(
    public readonly code: ProxyErrorEnvelope['error']['code'],
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'ProxyRequestError'
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates upstream URL: scheme, no userinfo, allowed path suffix, SSRF pre-check. */
export const validateProxyRequest = (
  targetUrl: string,
  upstreamAuth?: string,
): { valid: true } | { valid: false; code: ProxyErrorEnvelope['error']['code']; message: string } => {
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return { valid: false, code: 'INVALID_URL', message: 'URL could not be parsed.' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, code: 'INVALID_URL', message: 'Only HTTPS URLs are allowed.' }
  }

  if (parsed.username || parsed.password) {
    return { valid: false, code: 'INVALID_URL', message: 'URLs with credentials are not allowed.' }
  }

  const hostname = parsed.hostname.toLowerCase()
  if (hostname.endsWith('.local') || hostname === 'local') {
    return { valid: false, code: 'HOSTNAME_NOT_ALLOWED', message: 'This hostname is not allowed.' }
  }

  const validation = validateSafeUrl(targetUrl)
  if (!validation.valid) {
    return { valid: false, code: 'SSRF_BLOCKED', message: 'This address is not allowed for security reasons.' }
  }

  if (upstreamAuth !== undefined && !isPrintableAscii(upstreamAuth)) {
    return { valid: false, code: 'INVALID_URL', message: 'Invalid characters in API key.' }
  }

  return { valid: true }
}

/** Validates a baseUrl for the /models endpoint (appends /models to get the target). */
export const validateModelsRequest = (
  baseUrl: string,
  upstreamAuth?: string,
): { valid: true; modelsUrl: string } | { valid: false; code: ProxyErrorEnvelope['error']['code']; message: string } => {
  const normalized = baseUrl.replace(/\/+$/, '')
  const modelsUrl = `${normalized}/models`
  const result = validateProxyRequest(modelsUrl, upstreamAuth)
  if (!result.valid) return result
  return { valid: true, modelsUrl }
}

// ---------------------------------------------------------------------------
// Streaming with total byte cap
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenAI SDK stream into an SSE ReadableStream with a total-byte cap.
 * Emits `data: {json}\n\n` per chunk. Sends `data: [DONE]\n\n` at end.
 */
export const wrapStreamInSSE = (
  stream: AsyncIterable<unknown> & { controller?: AbortController },
  signal: AbortSignal,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  let totalBytes = 0
  let isCancelled = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (isCancelled || signal.aborted) break

          const line = `data: ${JSON.stringify(chunk)}\n\n`
          const encoded = encoder.encode(line)

          totalBytes += encoded.byteLength
          if (totalBytes > MAX_BYTES) {
            controller.error(new ProxyRequestError('BODY_TOO_LARGE', 'Response exceeded 50 MB cap.', 502))
            return
          }

          try {
            controller.enqueue(encoded)
          } catch {
            break
          }
        }

        if (!isCancelled && !signal.aborted) {
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch {
            // client disconnected
          }
        }

        if (controller.desiredSize !== null) {
          controller.close()
        }
      } catch (err) {
        if (!isCancelled) {
          controller.error(err)
        }
      }
    },
    cancel() {
      isCancelled = true
      stream.controller?.abort()
    },
  })
}

// ---------------------------------------------------------------------------
// Safe fetch
// ---------------------------------------------------------------------------

const safeFetch = createSafeFetch(globalThis.fetch)

/**
 * Wraps createSafeFetch, translating network errors into ProxyRequestError.
 * SSRF defense: createSafeFetch handles DNS resolve + ipaddr.js denylist +
 * per-hop redirect revalidation. See url-validation.ts + url-validation.test.ts.
 */
const safeFetchWrapped = async (url: string, init?: RequestInit): Promise<Response> => {
  try {
    return await safeFetch(url, init)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Blocked:')) {
      throw new ProxyRequestError('SSRF_BLOCKED', 'This address is not allowed for security reasons.', 400)
    }
    throw new ProxyRequestError('UPSTREAM_UNREACHABLE', 'Could not connect to the upstream server.', 502)
  }
}

// ---------------------------------------------------------------------------
// Elysia route factory
// ---------------------------------------------------------------------------

export const createCustomModelProxyRoutes = (auth: Auth) =>
  new Elysia({ prefix: '/v1/custom-model' })
    .use(createAuthMacro(auth))
    .post(
      '/proxy',
      async ({ request, user: sessionUser }) => {
        const body = (await request.json()) as CustomModelProxyRequest
        const { targetUrl, upstreamAuth, stream } = body

        const validation = validateProxyRequest(targetUrl, upstreamAuth)
        if (!validation.valid) {
          return proxyError(validation.code, validation.message, 400)
        }

        const userId = sessionUser!.id

        try {
          await perUserLimiter.consume(userId)
        } catch (err) {
          if (err instanceof RateLimiterRes) {
            return proxyError('RATE_LIMITED_USER', 'Rate limit exceeded. Try again later.', 429)
          }
          throw err
        }

        const abortController = new AbortController()
        request.signal?.addEventListener('abort', () => abortController.abort())
        AbortSignal.timeout(REQUEST_TIMEOUT_MS).addEventListener('abort', () => abortController.abort())

        try {
          const completionBody = body.body as ChatCompletionCreateParamsBase
          const parsedTarget = new URL(targetUrl)
          const baseUrl = parsedTarget.origin + parsedTarget.pathname.replace(/\/chat\/completions$|\/completions$/, '')
          const client = getCustomModelClient(baseUrl, upstreamAuth ?? 'no-key', safeFetchWrapped as typeof fetch)

          const typedClient = client as {
            chat: { completions: { create: (params: ChatCompletionCreateParamsBase & { stream: boolean }) => Promise<unknown> } }
          }

          if (stream) {
            const completion = await typedClient.chat.completions.create({ ...completionBody, stream: true })
            const sseStream = wrapStreamInSSE(
              completion as AsyncIterable<unknown> & { controller?: AbortController },
              abortController.signal,
            )
            return new Response(sseStream, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
            })
          }

          const completion = await typedClient.chat.completions.create({ ...completionBody, stream: false })
          return new Response(JSON.stringify({ data: completion }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          })
        } catch (err) {
          if (err instanceof ProxyRequestError) {
            return proxyError(err.code, err.message, err.httpStatus)
          }
          const msg = err instanceof Error ? err.message : String(err)
          return proxyError('UPSTREAM_UNREACHABLE', `Upstream error: ${msg.slice(0, 200)}`, 502)
        }
      },
      { auth: true },
    )
    .post(
      '/models',
      async ({ request, user: sessionUser }) => {
        const body = (await request.json()) as CustomModelModelsRequest
        const { baseUrl, upstreamAuth } = body

        const validation = validateModelsRequest(baseUrl, upstreamAuth)
        if (!validation.valid) {
          return proxyError(validation.code, validation.message, 400)
        }
        const { modelsUrl } = validation

        const userId = sessionUser!.id

        try {
          await perUserLimiter.consume(userId)
        } catch (err) {
          if (err instanceof RateLimiterRes) {
            return proxyError('RATE_LIMITED_USER', 'Rate limit exceeded. Try again later.', 429)
          }
          throw err
        }

        const outboundHeaders: Record<string, string> = {
          'User-Agent': USER_AGENT,
          'X-Abuse-Contact': ABUSE_CONTACT,
          Accept: 'application/json',
        }

        if (upstreamAuth) {
          outboundHeaders['Authorization'] = `Bearer ${upstreamAuth}`
        }

        try {
          const response = await safeFetchWrapped(modelsUrl, {
            method: 'GET',
            headers: outboundHeaders,
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          })

          if (response.status === 101) {
            return proxyError('UPSTREAM_PROTOCOL', 'Upstream attempted a protocol upgrade.', 502)
          }

          if (response.status === 401 || response.status === 403) {
            return proxyError('UPSTREAM_AUTH', 'Authentication failed. Check your API key.', 401)
          }

          const contentType = response.headers.get('content-type')
          if (!isAllowedContentType(contentType)) {
            return proxyError('UPSTREAM_CONTENT_TYPE', 'Upstream returned an unexpected content type.', 502)
          }

          const reader = response.body?.getReader()
          if (!reader) {
            return proxyError('UPSTREAM_UNREACHABLE', 'Upstream returned no body.', 502)
          }

          const chunks: Uint8Array[] = []
          let totalBytes = 0

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            totalBytes += value.byteLength
            if (totalBytes > MAX_BYTES) {
              await reader.cancel()
              return proxyError('BODY_TOO_LARGE', 'Upstream response exceeded 50 MB cap.', 502)
            }
            chunks.push(value)
          }

          const merged = chunks.reduce((acc, chunk) => {
            const out = new Uint8Array(acc.byteLength + chunk.byteLength)
            out.set(acc, 0)
            out.set(chunk, acc.byteLength)
            return out
          }, new Uint8Array(0))

          let parsed: unknown
          try {
            parsed = JSON.parse(new TextDecoder().decode(merged))
          } catch {
            return proxyError('UPSTREAM_UNREACHABLE', 'Upstream returned invalid JSON.', 502)
          }

          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !Array.isArray((parsed as Record<string, unknown>).data)
          ) {
            return proxyError('UPSTREAM_UNREACHABLE', 'Upstream models response has unexpected shape.', 502)
          }

          const cleanedHeaders = stripHopByHop(response.headers)

          return new Response(JSON.stringify(parsed), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              ...Object.fromEntries(cleanedHeaders.entries()),
            },
          })
        } catch (err) {
          if (err instanceof ProxyRequestError) {
            return proxyError(err.code, err.message, err.httpStatus)
          }
          const msg = err instanceof Error ? err.message : String(err)
          return proxyError('UPSTREAM_UNREACHABLE', `Upstream error: ${msg.slice(0, 200)}`, 502)
        }
      },
      { auth: true },
    )
