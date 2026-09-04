/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getSettings } from '@/config/settings'
import { classifyInferenceError } from '@/inference/error-kind'
import { createErrorResponse, getErrorStatus, getSafeErrorMessage, safeErrorHandler } from '@/middleware/error-handling'
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
  logInferenceSafely,
  runWithInferenceAttemptTracking,
  type InferenceClient,
  type InferenceLogger,
  type InferenceProxyLatencyLog,
} from './client'
import { resolveManagedDirectRuntime, type ManagedDirectRuntime } from './managed-models'
import {
  checkManagedInferenceAdmission,
  getInferenceQuotaLimits,
  recordInferenceUsage,
  type InferenceDatabase,
} from './usage-ledger'
import { createPriceUnavailableResponse, createQuotaExceededResponse } from './usage-responses'
import { rejectUnregisteredCliDevice } from './cli-device'

type Message = { role: string; content: unknown }

const privilegedRoles = new Set(['developer', 'system'])
const inferenceProxyTimingHeader = 'X-Proxy-Timing'
const serverTimingHeader = 'Server-Timing'

/** Downgrade developer/system roles to user for all messages except the first (the legitimate system prompt). */
const sanitizeMessageRoles = (messages: Message[]): Message[] =>
  messages.map((msg, i) => (i > 0 && privilegedRoles.has(msg.role) ? { ...msg, role: 'user' } : msg))

export type CreateInferenceRoutesOptions = {
  auth: Auth
  captureInferenceErrorFn?: typeof captureInferenceError
  database: InferenceDatabase
  fetchFn?: typeof fetch
  getClient?: (provider: ManagedDirectRuntime['provider']) => InferenceClient
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
  const { auth, database, fetchFn, logger, rateLimit } = options
  const settings = getSettings()
  const nowFn = options.nowFn ?? (() => performance.now())
  const isPostHogConfiguredFn = options.isPostHogConfiguredFn ?? isPostHogConfigured
  const captureInferenceErrorFn = options.captureInferenceErrorFn ?? captureInferenceError
  const getClient =
    options.getClient ??
    ((provider: ManagedDirectRuntime['provider']) => getInferenceClient(provider, { fetchFn, logger, nowFn }))
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
    guardedApp.onBeforeHandle(({ request, session, user }) =>
      rejectUnregisteredCliDevice(database, settings.cliDeviceRegistrationEnabled, { request, session, user }),
    )
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

      const modelConfig = resolveManagedDirectRuntime(body.model)
      if (!modelConfig) {
        throw new Error('Model not found')
      }

      const { provider, internalName, supportsStreamUsage, omitTemperature } = modelConfig
      const route = new URL(ctx.request.url).pathname
      const attemptTracker = createInferenceAttemptTracker()
      /** Emit route phase telemetry in structured logs and response headers. */
      const recordLatency = (
        status: number,
        completedAt: number,
        upstreamMs: number | null = elapsedMs(handlerStartedAt, completedAt),
      ) => {
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

        if (upstreamMs !== null) {
          ctx.set.headers[inferenceProxyTimingHeader] =
            `pre=${preMs};upstream=${upstreamMs};total=${totalMs};attempts=${attemptTracker.attempts}`
          ctx.set.headers[serverTimingHeader] = formatServerTiming(preMs, upstreamMs, totalMs)
        }
        logInferenceSafely(logger, latency, 'Inference proxy latency')
      }

      const admission = await checkManagedInferenceAdmission(
        database,
        { provider, model: internalName },
        ctx.user.id,
        getInferenceQuotaLimits(settings, ctx.user.isAnonymous === true),
      )
      if (admission.outcome === 'price-unavailable') {
        recordLatency(503, nowFn(), null)
        return createPriceUnavailableResponse()
      }
      if (admission.outcome === 'quota-exceeded') {
        recordLatency(429, nowFn(), null)
        return createQuotaExceededResponse(admission.decision)
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
          onUsage: async (counts) => {
            logInferenceSafely(
              logger,
              {
                event: 'inference_usage_completed',
                provider,
                model: internalName,
                eventId: usageEventId,
                transport: 'direct',
              },
              'Inference usage completed',
            )
            const outcome = await recordInferenceUsage(database, {
              id: usageEventId,
              userId: ctx.user.id,
              counts,
              price,
            })
            logInferenceSafely(
              logger,
              {
                event: 'inference_usage_inserted',
                provider,
                model: internalName,
                eventId: usageEventId,
                outcome,
              },
              'Inference usage inserted',
            )
          },
          onUsageMissing: () => {
            logger?.info(
              { event: 'inference_usage_missing', provider, model: internalName, route },
              'Inference usage missing',
            )
          },
          onUsageError: () => {
            logger?.info(
              { event: 'inference_usage_callback_failed', provider, model: internalName, route },
              'Inference usage callback failed',
            )
          },
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
  })
}

/**
 * Legacy export for backward compatibility
 * @deprecated Use createInferenceRoutes instead
 */
export const createOpenAIRoutes = createInferenceRoutes
