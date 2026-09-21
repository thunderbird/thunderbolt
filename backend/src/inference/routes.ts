/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getSettings } from '@/config/settings'
import { classifyInferenceError } from '@/inference/error-kind'
import { createErrorResponse, getErrorStatus, getSafeErrorMessage, safeErrorHandler } from '@/middleware/error-handling'
import { captureInferenceError, getPostHogClient, isPostHogConfigured } from '@/posthog/client'
import { createAnthropicSSEStream } from '@/utils/anthropic-streaming'
import { createSSEStreamFromCompletion, invokeObserverSafely } from '@/utils/streaming'
import { elapsedMs } from '@/utils/timing'
import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk'
import type Anthropic from '@anthropic-ai/sdk'
import type { MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { Elysia, type AnyElysia } from 'elysia'
import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { z } from 'zod'
import type { PostHog } from 'posthog-node'
import {
  createInferenceAttemptTracker,
  getAnthropicMessagesClient,
  getInferenceClient,
  logInferenceSafely,
  runWithInferenceAttemptTracking,
  type InferenceAttemptTracker,
  type InferenceClient,
  type InferenceLogger,
  type InferenceProvider,
  type InferenceProxyLatencyLog,
} from './client'
import { resolveManagedDirectRuntime, type ManagedDirectRuntime } from './managed-models'
import {
  checkManagedInferenceAdmission,
  getInferenceQuotaLimits,
  recordInferenceUsage,
  type InferenceDatabase,
  type InferencePrice,
  type InferenceTokenCounts,
} from './usage-ledger'
import { createPriceUnavailableResponse, createQuotaExceededResponse } from './usage-responses'
import { rejectUnregisteredCliDevice } from './cli-device'

type Message = { role: string; content: unknown }

const privilegedRoles = new Set(['developer', 'system'])
const inferenceProxyTimingHeader = 'X-Proxy-Timing'
const serverTimingHeader = 'Server-Timing'

const anthropicFunctionToolSchema = z.object({ name: z.string(), type: z.literal('custom').optional() }).passthrough()
const anthropicMessagesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.unknown()),
  max_tokens: z.number().int().positive(),
  stream: z.literal(true),
  system: z.unknown().optional(),
  tools: z.array(anthropicFunctionToolSchema).optional(),
  thinking: z.unknown().optional(),
  output_config: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  stop_sequences: z.array(z.string()).optional(),
})

/** Downgrade developer/system roles to user for all messages except the first (the legitimate system prompt). */
const sanitizeMessageRoles = (messages: Message[]): Message[] =>
  messages.map((msg, i) => (i > 0 && privilegedRoles.has(msg.role) ? { ...msg, role: 'user' } : msg))

export type CreateInferenceRoutesOptions = {
  auth: Auth
  captureInferenceErrorFn?: typeof captureInferenceError
  database: InferenceDatabase
  fetchFn?: typeof fetch
  getClient?: (provider: ManagedDirectRuntime['provider']) => InferenceClient
  getMessagesClient?: () => Anthropic
  isPostHogConfiguredFn?: () => boolean
  posthogClient?: PostHog
  logger?: InferenceLogger
  /** Monotonic clock used for route latency and upstream-attempt instrumentation. */
  nowFn?: () => number
  rateLimit?: AnyElysia
}

/** Format inference phases using Server-Timing header syntax. */
const formatServerTiming = (preMs: number, upstreamMs: number, totalMs: number): string =>
  `pre;dur=${preMs}, upstream;dur=${upstreamMs}, total;dur=${totalMs}`

type LatencyRecorderOptions = {
  attemptTracker: InferenceAttemptTracker
  handlerStartedAt: number
  headers: Record<string, string | number>
  logger?: InferenceLogger
  model: string
  provider: InferenceProvider
  requestStartedAt: number
  route: string
}

type LatencyRecorder = ReturnType<typeof createLatencyRecorder>

/** Emit route phase telemetry in structured logs and response headers. */
const createLatencyRecorder = ({
  attemptTracker,
  handlerStartedAt,
  headers,
  logger,
  model,
  provider,
  requestStartedAt,
  route,
}: LatencyRecorderOptions) => {
  const preMs = elapsedMs(requestStartedAt, handlerStartedAt)
  return (
    status: number,
    completedAt: number,
    upstreamMs: number | null = elapsedMs(handlerStartedAt, completedAt),
  ) => {
    const totalMs = elapsedMs(requestStartedAt, completedAt)
    const { attempts } = attemptTracker
    const latency: InferenceProxyLatencyLog = {
      event: 'inference_proxy_latency',
      route,
      provider,
      model,
      status,
      preMs,
      upstreamMs,
      totalMs,
      attempts,
    }
    if (upstreamMs !== null) {
      headers[inferenceProxyTimingHeader] = `pre=${preMs};upstream=${upstreamMs};total=${totalMs};attempts=${attempts}`
      headers[serverTimingHeader] = formatServerTiming(preMs, upstreamMs, totalMs)
    }
    logInferenceSafely(logger, latency, 'Inference proxy latency')
  }
}

const getApiErrorMetadata = (error: unknown) => {
  const openAiError = error instanceof APIError ? error : undefined
  const anthropicError = error instanceof AnthropicAPIError ? error : undefined
  return {
    errorType: openAiError?.type ?? anthropicError?.type ?? undefined,
    errorCode: openAiError?.code ?? undefined,
    requestId: openAiError?.requestID ?? anthropicError?.requestID ?? undefined,
  }
}

type UsageCallbacksOptions = {
  database: InferenceDatabase
  eventId: string
  logger?: InferenceLogger
  model: string
  price: InferencePrice
  provider: InferenceProvider
  route: string
  userId: string
}

/** Build the shared persistence and telemetry callbacks for a managed stream. */
const createUsageCallbacks = ({
  database,
  eventId,
  logger,
  model,
  price,
  provider,
  route,
  userId,
}: UsageCallbacksOptions) => ({
  onUsage: async (counts: InferenceTokenCounts) => {
    logInferenceSafely(
      logger,
      { event: 'inference_usage_completed', provider, model, eventId, transport: 'direct' },
      'Inference usage completed',
    )
    const outcome = await recordInferenceUsage(database, { id: eventId, userId, counts, price })
    logInferenceSafely(
      logger,
      { event: 'inference_usage_inserted', provider, model, eventId, outcome },
      'Inference usage inserted',
    )
  },
  onUsageMissing: () => {
    logger?.info({ event: 'inference_usage_missing', provider, model, route }, 'Inference usage missing')
  },
  onUsageError: () => {
    logger?.info(
      { event: 'inference_usage_callback_failed', provider, model, route },
      'Inference usage callback failed',
    )
  },
})

/** Merge middleware headers into a raw streaming response. */
const streamingResponseHeaders = (headers: object): Record<string, string> => {
  const responseHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) {
      responseHeaders[key] = String(value)
    }
  }
  return responseHeaders
}

/**
 * Inference API routes
 */
export const createInferenceRoutes = (options: CreateInferenceRoutesOptions) => {
  const { auth, database, fetchFn, logger, rateLimit } = options
  const settings = getSettings()
  const nowFn = options.nowFn ?? (() => performance.now())
  const isPostHogConfiguredFn = options.isPostHogConfiguredFn ?? isPostHogConfigured
  const captureInferenceErrorFn = options.captureInferenceErrorFn ?? captureInferenceError
  const getClient =
    options.getClient ??
    ((provider: ManagedDirectRuntime['provider']) => getInferenceClient(provider, { fetchFn, logger, nowFn }))
  const getMessagesClient = options.getMessagesClient ?? (() => getAnthropicMessagesClient({ fetchFn, logger, nowFn }))

  /** Gate a managed request on price and quota; a returned Response is the rejection to send. */
  const admitManagedRequest = async (
    { provider, internalName }: ManagedDirectRuntime,
    user: { id: string; isAnonymous?: boolean | null },
    recordLatency: LatencyRecorder,
  ): Promise<{ price: InferencePrice } | Response> => {
    const admission = await checkManagedInferenceAdmission(
      database,
      { provider, model: internalName },
      user.id,
      getInferenceQuotaLimits(settings, user.isAnonymous === true),
    )
    if (admission.outcome === 'price-unavailable') {
      recordLatency(503, nowFn(), null)
      return createPriceUnavailableResponse()
    }
    if (admission.outcome === 'quota-exceeded') {
      recordLatency(429, nowFn(), null)
      return createQuotaExceededResponse(admission.decision)
    }
    return admission
  }

  const app = new Elysia({
    prefix: '/chat',
  })
    .onError(safeErrorHandler)
    .decorate('inferenceRequestStartedAt', 0)
    .onRequest((ctx) => {
      // onRequest hooks become app-wide when plugins merge, so avoid timing unrelated routes.
      if (!ctx.request.url.includes('/chat/completions') && !ctx.request.url.includes('/chat/v1/messages')) {
        return
      }
      ctx.inferenceRequestStartedAt = nowFn()
    })

  return app.use(createAuthMacro(auth)).guard({ auth: true }, (guardedApp) => {
    guardedApp.onBeforeHandle(({ request, session, user }) =>
      rejectUnregisteredCliDevice(database, settings.cliDeviceRegistrationEnabled, { request, session, user }),
    )
    if (rateLimit) {
      guardedApp.use(rateLimit)
    }

    guardedApp.post('/completions', async (ctx) => {
      const handlerStartedAt = nowFn()
      const body = await ctx.request.json()

      if (!body.stream) {
        throw new Error('Non-streaming requests are not supported')
      }

      const modelConfig = resolveManagedDirectRuntime(body.model)
      if (!modelConfig) {
        throw new Error('Model not found')
      }

      const { provider, internalName, supportsStreamUsage, omitTemperature } = modelConfig
      const route = new URL(ctx.request.url).pathname
      const attemptTracker = createInferenceAttemptTracker()
      const recordLatency = createLatencyRecorder({
        attemptTracker,
        handlerStartedAt,
        headers: ctx.set.headers,
        logger,
        model: body.model,
        provider,
        requestStartedAt: ctx.inferenceRequestStartedAt,
        route,
      })

      const admission = await admitManagedRequest(modelConfig, ctx.user, recordLatency)
      if (admission instanceof Response) {
        return admission
      }
      const { price } = admission

      const usageEventId = crypto.randomUUID()
      const { client } = getClient(provider)

      try {
        const completion = await runWithInferenceAttemptTracking(attemptTracker, () =>
          (client as PostHogOpenAI).chat.completions.create({
            model: internalName,
            messages: sanitizeMessageRoles(body.messages) as ChatCompletionMessageParam[],
            ...(omitTemperature ? {} : { temperature: body.temperature }),
            tools: body.tools,
            tool_choice: body.tool_choice,
            stream: true,
            ...(supportsStreamUsage && { stream_options: { include_usage: true } }),
            ...(isPostHogConfiguredFn() && {
              posthogDistinctId: ctx.user.id,
              posthogProperties: {
                model_provider: provider,
                model: internalName,
                endpoint: '/chat/completions',
                has_tools: !!body.tools,
                temperature: body.temperature,
              },
            }),
          }),
        )
        const upstreamResolvedAt = nowFn()
        recordLatency(200, upstreamResolvedAt)

        const stream = createSSEStreamFromCompletion(completion, {
          ...createUsageCallbacks({
            database,
            eventId: usageEventId,
            logger,
            model: internalName,
            price,
            provider,
            route,
            userId: ctx.user.id,
          }),
          onError: (error) => {
            captureInferenceErrorFn({
              provider,
              status: getErrorStatus(error),
              model: body.model,
              errorKind: classifyInferenceError(error),
              ...getApiErrorMetadata(error),
              distinctId: ctx.user.id,
              phase: 'stream',
            })
          },
        })

        // Merge rate-limit headers (set by middleware on ctx.set.headers) into the
        // streaming Response so clients can read them. Elysia skips ctx.set.headers
        // when the handler returns a raw Response.
        return new Response(stream, { headers: streamingResponseHeaders(ctx.set.headers) })
      } catch (error) {
        const status = getErrorStatus(error)
        recordLatency(status, nowFn())
        // Keep failures diagnosable using body-free structured metadata only.
        captureInferenceErrorFn({
          provider,
          status,
          model: body.model,
          errorKind: classifyInferenceError(error),
          ...getApiErrorMetadata(error),
          distinctId: ctx.user.id,
        })
        if (!(error instanceof APIError)) {
          throw error
        }
        if (error instanceof APIConnectionTimeoutError) {
          logger?.info(
            { event: 'inference_connection_timeout', provider, model: internalName, route },
            'Connection timeout to inference provider',
          )
        } else if (error instanceof APIConnectionError) {
          logger?.info(
            { event: 'inference_connection_failed', provider, model: internalName, route },
            'Failed to connect to inference provider',
          )
        }
        ctx.set.status = status
        return createErrorResponse(getSafeErrorMessage(status))
      }
    })

    guardedApp.post('/v1/messages', async (ctx) => {
      const handlerStartedAt = nowFn()
      const requestBody = await ctx.request.json().catch(() => null)
      const parsedBody = anthropicMessagesRequestSchema.safeParse(requestBody)
      if (!parsedBody.success) {
        ctx.set.status = 400
        return createErrorResponse(getSafeErrorMessage(400))
      }
      const body = parsedBody.data
      const modelConfig = resolveManagedDirectRuntime(body.model)
      if (!modelConfig) {
        throw new Error('Model not found')
      }

      const { provider, internalName } = modelConfig
      const route = new URL(ctx.request.url).pathname
      const attemptTracker = createInferenceAttemptTracker()
      const recordLatency = createLatencyRecorder({
        attemptTracker,
        handlerStartedAt,
        headers: ctx.set.headers,
        logger,
        model: body.model,
        provider,
        requestStartedAt: ctx.inferenceRequestStartedAt,
        route,
      })

      const admission = await admitManagedRequest(modelConfig, ctx.user, recordLatency)
      if (admission instanceof Response) {
        return admission
      }
      const { price } = admission
      const usageEventId = crypto.randomUUID()
      /** Preserve generation telemetry without sending prompt, response, or provider error content. */
      const captureGeneration = (status: number, counts?: InferenceTokenCounts) => {
        if (!isPostHogConfiguredFn()) {
          return
        }
        invokeObserverSafely(() =>
          (options.posthogClient ?? getPostHogClient()).capture({
            distinctId: ctx.user.id,
            event: '$ai_generation',
            properties: {
              model_provider: provider,
              model: internalName,
              endpoint: '/chat/v1/messages',
              has_tools: !!body.tools,
              $ai_trace_id: usageEventId,
              $ai_provider: provider,
              $ai_model: internalName,
              $ai_latency: elapsedMs(handlerStartedAt, nowFn()) / 1000,
              $ai_http_status: status,
              $ai_is_error: status >= 400,
              ...(counts && { $ai_input_tokens: counts.promptTokens, $ai_output_tokens: counts.completionTokens }),
            },
          }),
        )
      }

      try {
        const upstreamBody = {
          model: internalName,
          messages: body.messages,
          max_tokens: body.max_tokens,
          stream: true,
          // Anthropic's request-level automatic caching: the API moves this breakpoint to the
          // last cacheable block each turn. It coexists with Pi's explicit per-block breakpoints.
          cache_control: { type: 'ephemeral' },
          system: body.system,
          tools: body.tools,
          thinking: body.thinking,
          output_config: body.output_config,
          tool_choice: body.tool_choice,
          stop_sequences: body.stop_sequences,
          // The schema passes the Anthropic-shaped fields through as `unknown`; the SDK validates them.
        } as MessageCreateParamsStreaming
        const upstream = await runWithInferenceAttemptTracking(attemptTracker, () =>
          getMessagesClient().messages.create(upstreamBody),
        )
        const upstreamResolvedAt = nowFn()
        recordLatency(200, upstreamResolvedAt)

        const usageCallbacks = createUsageCallbacks({
          database,
          eventId: usageEventId,
          logger,
          model: internalName,
          price,
          provider,
          route,
          userId: ctx.user.id,
        })
        const stream = createAnthropicSSEStream(upstream, {
          ...usageCallbacks,
          onUsage: async (counts) => {
            captureGeneration(200, counts)
            await usageCallbacks.onUsage(counts)
          },
          onError: (error) => {
            captureGeneration(getErrorStatus(error))
            captureInferenceErrorFn({
              provider,
              status: getErrorStatus(error),
              model: body.model,
              errorKind: classifyInferenceError(error),
              ...getApiErrorMetadata(error),
              distinctId: ctx.user.id,
              phase: 'stream',
            })
          },
        })
        return new Response(stream, { headers: streamingResponseHeaders(ctx.set.headers) })
      } catch (error) {
        const status = getErrorStatus(error)
        captureGeneration(status)
        recordLatency(status, nowFn())
        captureInferenceErrorFn({
          provider,
          status,
          model: body.model,
          errorKind: classifyInferenceError(error),
          ...getApiErrorMetadata(error),
          distinctId: ctx.user.id,
        })
        if (!(error instanceof AnthropicAPIError)) {
          throw error
        }
        ctx.set.status = status
        return createErrorResponse(getSafeErrorMessage(status))
      }
    })

    return guardedApp
  })
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use createInferenceRoutes instead
 */
export const createOpenAIRoutes = createInferenceRoutes
