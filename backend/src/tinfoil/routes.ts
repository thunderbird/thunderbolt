/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getSettings } from '@/config/settings'
import { errorKindFromStatus } from '@/inference/error-kind'
import { logInferenceSafely, type InferenceLogger } from '@/inference/client'
import { createPriceUnavailableResponse, createQuotaExceededResponse } from '@/inference/usage-responses'
import {
  checkManagedInferenceAdmission,
  getInferenceQuotaLimits,
  type InferenceDatabase,
} from '@/inference/usage-ledger'
import { issueInferenceUsageReceipt } from '@/inference/usage-receipt'
import { safeErrorHandler } from '@/middleware/error-handling'
import { captureInferenceError } from '@/posthog/client'
import { capStream } from '@/proxy/streaming'
import { filterHeaders } from '@/utils/request'
import { elapsedMs } from '@/utils/timing'
import { tinfoilUpstreamIdleTimeoutMessage, tinfoilUpstreamTimeoutMessage } from '@shared/tinfoil-proxy'
import { inferenceUsageReceiptHeader, managedGlmIdentity } from '@shared/inference-usage'
import { Elysia, type AnyElysia } from 'elysia'
import { tinfoilUpstreamOriginStore, type TinfoilUpstreamOriginStore } from './upstream-origin'

const allowedMethods = new Set(['GET', 'POST', 'OPTIONS'])
const bodylessMethods = new Set(['GET', 'OPTIONS'])
const defaultUpstreamHeadersTimeoutMs = 30_000
const defaultUpstreamIdleTimeoutMs = 60_000
const abruptResponseCloseTimeoutSeconds = 1
const upstreamHeadersTimeoutError = new DOMException(tinfoilUpstreamTimeoutMessage, 'TimeoutError')
const upstreamIdleTimeoutError = new DOMException(tinfoilUpstreamIdleTimeoutMessage, 'TimeoutError')
const tinfoilEnclaveUrlHeader = 'x-tinfoil-enclave-url'
const tinfoilProxyTimingHeader = 'X-Proxy-Timing'
const serverTimingHeader = 'Server-Timing'

export type TinfoilProxyLatencyLog = {
  event: 'tinfoil_proxy_latency'
  route: string
  status: number
  preHandlerMs: number
  handlerToUpstreamFetchMs: number | null
  upstreamFetchToHeadersMs: number | null
  handlerToOutcomeMs: number
}

export type TinfoilProxyLogger = {
  info: (context: TinfoilProxyLatencyLog, message: string) => void
}

const textResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })

/** Format available Tinfoil proxy phases using the Server-Timing header syntax. */
const formatServerTiming = (
  preHandlerMs: number,
  handlerToUpstreamFetchMs: number | null,
  upstreamFetchToHeadersMs: number | null,
): string =>
  [
    `pre;dur=${preHandlerMs}`,
    handlerToUpstreamFetchMs === null ? null : `fetch;dur=${handlerToUpstreamFetchMs}`,
    upstreamFetchToHeadersMs === null ? null : `headers;dur=${upstreamFetchToHeadersMs}`,
  ]
    .filter((metric): metric is string => metric !== null)
    .join(', ')

/** Check whether an error's cause chain contains the target value. */
const errorCauseIncludes = (error: unknown, target: unknown): boolean =>
  error instanceof Error && (error.cause === target || errorCauseIncludes(error.cause, target))

/** Identify fetch rejection caused by the downstream client closing its request. */
const isClientAbortError = (error: unknown, requestSignal: AbortSignal): boolean =>
  requestSignal.aborted ||
  (error instanceof Error && error.name === 'AbortError' && errorCauseIncludes(error, requestSignal))

/** Decode percent escapes only for managed-policy path comparison. */
const decodePolicyPathname = (pathname: string): string => {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

/** Resolve an optional ATC-assigned enclave origin, applying the configured API path prefix. */
const resolveEnclaveUrl = (
  assignedEnclaveUrl: string | null,
  fallbackEnclaveUrl: string,
  apiPathPrefix: string,
): string | null => {
  if (assignedEnclaveUrl === null) {
    return fallbackEnclaveUrl
  }

  try {
    const parsedUrl = new URL(assignedEnclaveUrl)
    const isAllowedHostname = parsedUrl.hostname === 'tinfoil.sh' || parsedUrl.hostname.endsWith('.tinfoil.sh')

    if (parsedUrl.protocol !== 'https:' || !isAllowedHostname) {
      return null
    }

    return `${parsedUrl.origin}${apiPathPrefix}`
  } catch {
    return null
  }
}

/** Forwards HPKE-encrypted bodies to the Tinfoil enclave; injects the bearer key from env. */
export type CreateTinfoilRoutesOptions = {
  auth: Auth
  database: InferenceDatabase
  fetchFn?: typeof fetch
  logger?: TinfoilProxyLogger
  usageLogger?: InferenceLogger
  /** Monotonic clock used for latency instrumentation. */
  nowFn?: () => number
  rateLimit?: AnyElysia
  /** Override the enclave bearer key. Defaults to `TINFOIL_API_KEY`. */
  apiKey?: string
  /** Override the upstream enclave URL. Defaults to `TINFOIL_ENCLAVE_URL`. */
  enclaveUrl?: string
  /** Time allowed for upstream response headers. Defaults to 30 seconds. */
  upstreamHeadersTimeoutMs?: number
  /** Maximum idle time between upstream response chunks. Defaults to 60 seconds. */
  upstreamIdleTimeoutMs?: number
  upstreamOriginStore?: Pick<TinfoilUpstreamOriginStore, 'record'>
  captureInferenceErrorFn?: typeof captureInferenceError
}

export const createTinfoilRoutes = (options: CreateTinfoilRoutesOptions) => {
  const { auth, database, rateLimit } = options
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const logger = options.logger
  const usageLogger = options.usageLogger
  const nowFn = options.nowFn ?? (() => performance.now())
  const settings = getSettings()
  const apiKey = options.apiKey ?? settings.tinfoilApiKey
  const enclaveUrl = (options.enclaveUrl ?? settings.tinfoilEnclaveUrl).replace(/\/$/, '')
  const enclaveApiPathPrefix = new URL(enclaveUrl).pathname.replace(/\/$/, '')
  const upstreamHeadersTimeoutMs = options.upstreamHeadersTimeoutMs ?? defaultUpstreamHeadersTimeoutMs
  const upstreamIdleTimeoutMs = options.upstreamIdleTimeoutMs ?? defaultUpstreamIdleTimeoutMs
  const upstreamOriginStore = options.upstreamOriginStore ?? tinfoilUpstreamOriginStore
  const captureInferenceErrorFn = options.captureInferenceErrorFn ?? captureInferenceError

  const proxyToEnclave = async (
    requestStartedAt: number,
    request: Request,
    wildcard: string,
    server: Bun.Server<unknown> | null,
    setHeaders: Record<string, string | string[] | number>,
    distinctId: string,
    isAnonymous: boolean,
  ): Promise<Response> => {
    const handlerStartedAt = nowFn()
    const preHandlerMs = elapsedMs(requestStartedAt, handlerStartedAt)
    const requestUrl = new URL(request.url)
    const route = requestUrl.pathname
    const method = request.method.toUpperCase()
    const recordLatency = ({
      status,
      completedAt,
      upstreamFetchStartedAt = null,
      upstreamHeadersReceivedAt = null,
    }: {
      status: number
      completedAt: number
      upstreamFetchStartedAt?: number | null
      upstreamHeadersReceivedAt?: number | null
    }) => {
      const handlerToUpstreamFetchMs =
        upstreamFetchStartedAt === null ? null : elapsedMs(handlerStartedAt, upstreamFetchStartedAt)
      const upstreamFetchToHeadersMs =
        upstreamFetchStartedAt === null || upstreamHeadersReceivedAt === null
          ? null
          : elapsedMs(upstreamFetchStartedAt, upstreamHeadersReceivedAt)
      const latency: TinfoilProxyLatencyLog = {
        event: 'tinfoil_proxy_latency',
        route,
        status,
        preHandlerMs,
        handlerToUpstreamFetchMs,
        upstreamFetchToHeadersMs,
        handlerToOutcomeMs: elapsedMs(handlerStartedAt, completedAt),
      }

      setHeaders[tinfoilProxyTimingHeader] =
        `pre=${preHandlerMs};fetch=${handlerToUpstreamFetchMs ?? 'na'};headers=${upstreamFetchToHeadersMs ?? 'na'}`
      setHeaders[serverTimingHeader] = formatServerTiming(
        preHandlerMs,
        handlerToUpstreamFetchMs,
        upstreamFetchToHeadersMs,
      )
      logger?.info(latency, 'Tinfoil proxy latency')
    }

    if (!allowedMethods.has(method)) {
      recordLatency({ status: 405, completedAt: nowFn() })
      return textResponse(405, 'Method not allowed')
    }

    if (!apiKey) {
      recordLatency({ status: 503, completedAt: nowFn() })
      return textResponse(503, 'Tinfoil provider not configured')
    }

    // ATC dynamically assigns the enclave whose HPKE key sealed this body, so forwarding elsewhere guarantees a
    // key-config 422; only HTTPS tinfoil.sh hosts are accepted here as the SSRF guard.
    const upstreamBaseUrl = resolveEnclaveUrl(
      request.headers.get(tinfoilEnclaveUrlHeader),
      enclaveUrl,
      enclaveApiPathPrefix,
    )
    if (upstreamBaseUrl === null) {
      recordLatency({ status: 400, completedAt: nowFn() })
      return textResponse(400, 'Invalid X-Tinfoil-Enclave-Url: expected an HTTPS tinfoil.sh host')
    }

    const subpath = wildcard.startsWith('/') ? wildcard : `/${wildcard}`
    const search = requestUrl.search
    const upstreamUrl = `${upstreamBaseUrl}${subpath}${search}`
    upstreamOriginStore.record(upstreamUrl)

    let receipt: { eventId: string; token: string } | null = null
    const isManagedGlmChat =
      method === 'POST' && decodePolicyPathname(new URL(upstreamUrl).pathname) === '/v1/chat/completions'
    if (isManagedGlmChat) {
      const admission = await checkManagedInferenceAdmission(
        database,
        managedGlmIdentity,
        distinctId,
        getInferenceQuotaLimits(settings, isAnonymous),
      )
      if (admission.outcome === 'price-unavailable') {
        recordLatency({ status: 503, completedAt: nowFn() })
        return createPriceUnavailableResponse()
      }
      if (admission.outcome === 'quota-exceeded') {
        recordLatency({ status: 429, completedAt: nowFn() })
        return createQuotaExceededResponse(admission.decision)
      }
      const { price } = admission
      const eventId = crypto.randomUUID()
      receipt = {
        eventId,
        token: issueInferenceUsageReceipt({
          eventId,
          userId: distinctId,
          price: { ...price, ...managedGlmIdentity },
          secret: settings.betterAuthSecret,
          nowSeconds: Math.floor(Date.now() / 1_000),
        }),
      }
    }

    const headers = new Headers()
    request.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (
        lower === 'authorization' ||
        lower === 'host' ||
        lower === 'cookie' ||
        lower === 'connection' ||
        lower === tinfoilEnclaveUrlHeader
      ) {
        return
      }
      headers.set(key, value)
    })
    headers.set('Authorization', `Bearer ${apiKey}`)

    const body = bodylessMethods.has(method) ? null : request.body
    const upstreamController = new AbortController()
    const signal = AbortSignal.any([request.signal, upstreamController.signal])
    const headersTimeoutId = setTimeout(
      () => upstreamController.abort(upstreamHeadersTimeoutError),
      upstreamHeadersTimeoutMs,
    )
    const upstreamFetchStartedAt = nowFn()
    let hasCapturedInferenceError = false

    // Bun-specific fetch options: `duplex: 'half'` enables streaming request
    // bodies; `decompress: false` keeps the HPKE-encrypted bytes opaque on
    // the response path so the frontend SDK can decrypt them as-is.
    try {
      const upstream = await fetchFn(upstreamUrl, {
        method,
        headers,
        body,
        signal,
        redirect: 'manual',
        decompress: false,
        duplex: 'half',
      } as RequestInit & { decompress: boolean; duplex: 'half' })
      const upstreamHeadersReceivedAt = nowFn()

      // Strip upstream CORS headers: the enclave emits a duplicated
      // `Access-Control-Allow-Credentials: true, true`, which browsers reject
      // outright. Our own cors() middleware sets the correct CORS headers for
      // our origin (including Ehbp-Response-Nonce in expose-headers).
      const responseHeaders = filterHeaders(upstream.headers, [
        'transfer-encoding',
        'connection',
        inferenceUsageReceiptHeader,
        /^access-control-/i,
      ])
      if (upstream.ok && receipt) {
        responseHeaders.set(inferenceUsageReceiptHeader, receipt.token)
        logInferenceSafely(
          usageLogger,
          {
            event: 'inference_usage_receipt_issued',
            ...managedGlmIdentity,
            eventId: receipt.eventId,
            route,
          },
          'Inference usage receipt issued',
        )
      }

      const responseBody = upstream.body
        ? capStream(upstream.body, {
            idleTimeoutMs: upstreamIdleTimeoutMs,
            onIdle: 'error',
            idleError: upstreamIdleTimeoutError,
            onAbort: (reason) => {
              upstreamController.abort(upstreamIdleTimeoutError)
              if (reason !== 'idle' || request.signal.aborted || hasCapturedInferenceError) {
                return
              }
              hasCapturedInferenceError = true
              captureInferenceErrorFn({
                provider: 'tinfoil',
                status: 504,
                errorKind: 'connection',
                subpath,
                distinctId,
                phase: 'stream',
              })
            },
            // Bun serializes controller.error() after headers as clean chunked EOF.
            // Keep body pending and let native request timeout reset socket instead.
            onIdleError: server ? () => server.timeout(request, abruptResponseCloseTimeoutSeconds) : undefined,
          }).stream
        : null

      const response = new Response(responseBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      })
      recordLatency({
        status: upstream.status,
        completedAt: upstreamHeadersReceivedAt,
        upstreamFetchStartedAt,
        upstreamHeadersReceivedAt,
      })

      // The enclave body is HPKE-opaque (and the model lives inside it), so only
      // status + subpath are readable here. Record non-2xx upstreams so a Tinfoil
      // failure stays diagnosable from telemetry without touching the stream.
      if (!upstream.ok) {
        hasCapturedInferenceError = true
        captureInferenceErrorFn({
          provider: 'tinfoil',
          status: upstream.status,
          errorKind: errorKindFromStatus(upstream.status),
          subpath,
          distinctId,
        })
      }

      return response
    } catch (error) {
      const completedAt = nowFn()
      const isClientAbort = isClientAbortError(error, request.signal)
      const status = isClientAbort ? 499 : error === upstreamHeadersTimeoutError ? 504 : 500
      recordLatency({
        status,
        completedAt,
        upstreamFetchStartedAt,
      })

      if (!isClientAbort && !hasCapturedInferenceError) {
        hasCapturedInferenceError = true
        captureInferenceErrorFn({
          provider: 'tinfoil',
          status,
          errorKind: 'connection',
          subpath,
          distinctId,
        })
      }

      if (error === upstreamHeadersTimeoutError) {
        return textResponse(504, tinfoilUpstreamTimeoutMessage)
      }
      throw error
    } finally {
      clearTimeout(headersTimeoutId)
    }
  }

  // `{ parse: 'none' }` keeps the request stream untouched so the HPKE-encrypted
  // payload reaches the upstream unchanged, even for recognised content types.
  // The wildcard-derived subpath survives changes to the outer mount prefix
  // (e.g. `/v1` in src/index.ts). Branching at `.all()` keeps each chain's
  // Elysia type concrete (a ternary `g` vs `g.use(...)` would union the types
  // and make `.all()` uncallable / fall back to `any`).
  return new Elysia({ prefix: '/tinfoil' })
    .onError(safeErrorHandler)
    .decorate('tinfoilRequestStartedAt', 0)
    .onRequest((ctx) => {
      // onRequest hooks become app-wide when plugins merge, so avoid timing unrelated routes.
      if (!ctx.request.url.includes('/tinfoil/')) {
        return
      }
      ctx.tinfoilRequestStartedAt = nowFn()
    })
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) => {
      if (rateLimit) {
        return g
          .use(rateLimit)
          .all(
            '/*',
            (ctx) =>
              proxyToEnclave(
                ctx.tinfoilRequestStartedAt,
                ctx.request,
                ctx.params['*'] ?? '',
                ctx.server,
                ctx.set.headers,
                ctx.user.id,
                ctx.user.isAnonymous === true,
              ),
            { parse: 'none' },
          )
      }
      return g.all(
        '/*',
        (ctx) =>
          proxyToEnclave(
            ctx.tinfoilRequestStartedAt,
            ctx.request,
            ctx.params['*'] ?? '',
            ctx.server,
            ctx.set.headers,
            ctx.user.id,
            ctx.user.isAnonymous === true,
          ),
        { parse: 'none' },
      )
    })
}
