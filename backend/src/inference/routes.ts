/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { BadRequestError } from '@/errors/http-errors'
import { classifyInferenceError } from '@/inference/error-kind'
import { createErrorResponse, getErrorStatus, safeErrorHandler } from '@/middleware/error-handling'
import { captureInferenceError, isPostHogConfigured } from '@/posthog/client'
import { createSSEStreamFromCompletion } from '@/utils/streaming'
import { elapsedMs } from '@/utils/timing'
import type { OpenAI as PostHogOpenAI } from '@posthog/ai'
import { Elysia, type AnyElysia } from 'elysia'
import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import {
  createInferenceAttemptTracker,
  getInferenceClient,
  runWithInferenceAttemptTracking,
  type InferenceClient,
  type InferenceLogger,
  type InferenceProvider,
} from './client'

type Message = { role: string; content: unknown }

const privilegedRoles = new Set(['developer', 'system'])
const inferenceProxyTimingHeader = 'X-Proxy-Timing'
const serverTimingHeader = 'Server-Timing'

/** Downgrade developer/system roles to user for all messages except the first (the legitimate system prompt). */
const sanitizeMessageRoles = (messages: Message[]): Message[] =>
  messages.map((msg, i) => (i > 0 && privilegedRoles.has(msg.role) ? { ...msg, role: 'user' } : msg))

type ModelConfig = {
  provider: InferenceProvider
  internalName: string
  /** Whether to omit `temperature` from the upstream payload. */
  omitTemperature?: boolean
}

export const supportedModels: Record<string, ModelConfig> = {
  'opus-5': {
    provider: 'anthropic',
    internalName: 'claude-opus-5',
    omitTemperature: true,
  },
  // Legacy alias for the pre-rename model id. Stale clients (an open tab whose session
  // captured the old model object, a desynced device) keep sending 'opus-4.8' after the
  // default model was renamed to 'opus-5'; routing it to the same upstream keeps those
  // clients working instead of 500ing on every send. The rename that caused this incident
  // shipped without this alias — any future default-model rename must add one too.
  'opus-4.8': {
    provider: 'anthropic',
    internalName: 'claude-opus-5',
    omitTemperature: true,
  },
  'deepseek-v4-flash': {
    provider: 'fireworks',
    internalName: 'accounts/fireworks/models/deepseek-v4-flash',
  },
}

export type InferenceProxyLatencyLog = {
  event: 'inference_proxy_latency'
  route: string
  /** 'unknown' when the request was rejected before a provider could be resolved (e.g. bad model id). */
  provider: InferenceProvider | 'unknown'
  model: string
  status: number
  preMs: number
  upstreamMs: number
  totalMs: number
  attempts: number
}

export type CreateInferenceRoutesOptions = {
  auth: Auth
  captureInferenceErrorFn?: typeof captureInferenceError
  fetchFn?: typeof fetch
  getClient?: (provider: InferenceProvider) => InferenceClient
  isPostHogConfiguredFn?: () => boolean
  logger?: InferenceLogger
  /** Monotonic clock used for route latency and upstream-attempt instrumentation. */
  nowFn?: () => number
  rateLimit?: AnyElysia
}

/** Format inference phases using Server-Timing header syntax. */
const formatServerTiming = (preMs: number, upstreamMs: number, totalMs: number): string =>
  `pre;dur=${preMs}, upstream;dur=${upstreamMs}, total;dur=${totalMs}`

const getApiErrorMetadata = (error: unknown) => {
  const apiError = error instanceof APIError ? error : undefined
  return {
    errorType: apiError?.type,
    errorCode: apiError?.code ?? undefined,
    requestId: apiError?.requestID ?? undefined,
  }
}

/**
 * Inference API routes
 */
export const createInferenceRoutes = (options: CreateInferenceRoutesOptions) => {
  const { auth, fetchFn, logger, rateLimit } = options
  const nowFn = options.nowFn ?? (() => performance.now())
  const isPostHogConfiguredFn = options.isPostHogConfiguredFn ?? isPostHogConfigured
  const captureInferenceErrorFn = options.captureInferenceErrorFn ?? captureInferenceError
  const getClient =
    options.getClient ?? ((provider: InferenceProvider) => getInferenceClient(provider, { fetchFn, logger, nowFn }))
  const app = new Elysia({
    prefix: '/chat',
  })
    .onError(safeErrorHandler)
    .decorate('inferenceRequestStartedAt', 0)
    .onRequest((ctx) => {
      // onRequest hooks become app-wide when plugins merge, so avoid timing unrelated routes.
      if (!ctx.request.url.includes('/chat/completions')) {
        return
      }
      ctx.inferenceRequestStartedAt = nowFn()
    })

  return app.use(createAuthMacro(auth)).guard({ auth: true }, (guardedApp) => {
    if (rateLimit) {
      guardedApp.use(rateLimit)
    }

    return guardedApp.post('/completions', async (ctx) => {
      const handlerStartedAt = nowFn()
      const preMs = elapsedMs(ctx.inferenceRequestStartedAt, handlerStartedAt)
      const body = await ctx.request.json()

      if (!body.stream) {
        throw new Error('Non-streaming requests are not supported')
      }

      const route = new URL(ctx.request.url).pathname
      const attemptTracker = createInferenceAttemptTracker()
      /** Emit route phase telemetry in structured logs and response headers. */
      const recordLatency = (provider: InferenceProvider | 'unknown', status: number, completedAt: number) => {
        const upstreamMs = elapsedMs(handlerStartedAt, completedAt)
        const totalMs = elapsedMs(ctx.inferenceRequestStartedAt, completedAt)
        const latency: InferenceProxyLatencyLog = {
          event: 'inference_proxy_latency',
          route,
          provider,
          model: body.model,
          status,
          preMs,
          upstreamMs,
          totalMs,
          attempts: attemptTracker.attempts,
        }

        ctx.set.headers[inferenceProxyTimingHeader] =
          `pre=${preMs};upstream=${upstreamMs};total=${totalMs};attempts=${attemptTracker.attempts}`
        ctx.set.headers[serverTimingHeader] = formatServerTiming(preMs, upstreamMs, totalMs)
        logger?.info(latency, 'Inference proxy latency')
      }

      const modelConfig = supportedModels[body.model]
      if (!modelConfig) {
        // Caller error, not an upstream failure — no provider was ever reached, so this only
        // feeds the proxy latency log (captureInferenceErrorFn's inference_upstream_error event
        // doesn't apply). Echoing the model id back is safe: it's the caller's own input.
        // Must NOT `throw` here — that would route through `.onError(safeErrorHandler)`, which
        // replaces the message with a generic HTTP reason phrase and drops the model id.
        const error = new BadRequestError(`Unknown model: ${body.model}`)
        recordLatency('unknown', error.status, nowFn())
        ctx.set.status = error.status
        return createErrorResponse(error.message)
      }

      const { provider, internalName, omitTemperature } = modelConfig
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
            ...(isPostHogConfiguredFn() && {
              posthogProperties: {
                model_provider: provider,
                endpoint: '/chat/completions',
                has_tools: !!body.tools,
                temperature: body.temperature,
                // @todo add distinct id and trace id
              },
            }),
          }),
        )
        const upstreamResolvedAt = nowFn()
        recordLatency(provider, 200, upstreamResolvedAt)

        const stream = createSSEStreamFromCompletion(completion, {
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
        const responseHeaders: Record<string, string> = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        }
        for (const [key, value] of Object.entries(ctx.set.headers)) {
          if (value != null) {
            responseHeaders[key] = String(value)
          }
        }

        return new Response(stream, { headers: responseHeaders })
      } catch (error) {
        const status = getErrorStatus(error)
        recordLatency(provider, status, nowFn())
        // Keep failures diagnosable using body-free structured metadata only.
        captureInferenceErrorFn({
          provider,
          status,
          model: body.model,
          errorKind: classifyInferenceError(error),
          ...getApiErrorMetadata(error),
          distinctId: ctx.user.id,
        })
        if (error instanceof APIConnectionTimeoutError) {
          console.error('Connection timeout to inference provider', error.cause)
          throw new Error('Connection timeout to inference provider', { cause: error })
        }
        if (error instanceof APIConnectionError) {
          console.error('Failed to connect to inference provider', error.cause)
          throw new Error('Failed to connect to inference provider', { cause: error })
        }
        throw error
      }
    })
  })
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use createInferenceRoutes instead
 */
export const createOpenAIRoutes = createInferenceRoutes
