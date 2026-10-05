/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { streamingResponseHeaders } from '@/inference/routes'
import {
  checkManagedInferenceAdmission,
  getInferenceQuotaLimits,
  recordInferenceUsage,
  type InferenceDatabase,
  type InferenceTokenCounts,
  type ManagedInferenceIdentity,
} from '@/inference/usage-ledger'
import { createPriceUnavailableResponse, createQuotaExceededResponse } from '@/inference/usage-responses'
import {
  createErrorResponse,
  getSafeErrorMessage,
  getSafeLogMessage,
  safeErrorHandler,
} from '@/middleware/error-handling'
import { readBodyWithinLimit } from '@/utils/request-body'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  APICallError,
  convertToModelMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
} from 'ai'
import { Elysia, type AnyElysia } from 'elysia'
import type { Logger } from 'pino'
import { parseAgentChatRequest } from './history'
import { resolveAgentSystemPrompt } from './prompt'

export const agentMaxOutputTokens = 8192
export const maxRequestBytes = 2_000_000

export type CreateHostedAgentRoutesOptions = {
  auth: Auth
  database: InferenceDatabase
  settings: Settings
  logger?: Pick<Logger, 'error'>
  rateLimit?: AnyElysia
  /** Defaults to `AGENT_MODEL` on the managed Anthropic key. */
  model?: LanguageModel
  checkAdmission?: typeof checkManagedInferenceAdmission
  recordUsage?: typeof recordInferenceUsage
}

/** Map AI SDK usage, summed across steps, onto the ledger's token counts. */
const toTokenCounts = (usage: LanguageModelUsage): InferenceTokenCounts => ({
  promptTokens: usage.inputTokens ?? 0,
  completionTokens: usage.outputTokens ?? 0,
  totalTokens: usage.totalTokens ?? 0,
  cacheCreationTokens: usage.inputTokenDetails.cacheWriteTokens,
  cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
})

/**
 * Hosted agent routes: `POST /agent/chat` takes a `DefaultChatTransport` body and streams a UI message
 * response. Stateless: the browser owns the conversation and resends it each turn. Mounts nothing unless
 * `AGENT_ENABLED` is set.
 */
export const createHostedAgentRoutes = async (options: CreateHostedAgentRoutesOptions) => {
  const { auth, database, settings, logger, rateLimit } = options
  if (!settings.agentEnabled) {
    return new Elysia({ name: 'hosted-agent-routes' })
  }
  if (!settings.agentModel) {
    throw new Error('AGENT_MODEL is required when AGENT_ENABLED is true')
  }
  if (!options.model && !settings.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required when AGENT_ENABLED is true')
  }

  const checkAdmission = options.checkAdmission ?? checkManagedInferenceAdmission
  const recordUsage = options.recordUsage ?? recordInferenceUsage
  const identity: ManagedInferenceIdentity = { provider: 'anthropic', model: settings.agentModel }
  const system = (await resolveAgentSystemPrompt(settings.agentSystemPrompt)) || undefined
  const model =
    options.model ??
    createAnthropic({
      apiKey: settings.anthropicApiKey,
      baseURL: `${settings.anthropicBaseUrl.replace(/\/$/, '')}/v1`,
    })(settings.agentModel)

  return new Elysia({ name: 'hosted-agent-routes', prefix: '/agent' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (guardedApp) => {
      if (rateLimit) {
        guardedApp.use(rateLimit)
      }

      return guardedApp.post(
        '/chat',
        async (ctx) => {
          const rawBody = await readBodyWithinLimit(ctx.request, maxRequestBytes)
          if (rawBody === null) {
            ctx.set.status = 413
            return createErrorResponse(getSafeErrorMessage(413))
          }
          const parsed = parseAgentChatRequest(rawBody)
          if (!parsed.ok) {
            ctx.set.status = parsed.status
            return createErrorResponse(getSafeErrorMessage(parsed.status))
          }

          const admission = await checkAdmission(
            database,
            identity,
            ctx.user.id,
            getInferenceQuotaLimits(settings, ctx.user.isAnonymous === true),
          )
          if (admission.outcome === 'price-unavailable') {
            return createPriceUnavailableResponse()
          }
          if (admission.outcome === 'quota-exceeded') {
            return createQuotaExceededResponse(admission.decision)
          }

          const usageEventId = crypto.randomUUID()
          const logContext = { provider: identity.provider, model: identity.model, eventId: usageEventId }
          const result = streamText({
            model,
            system,
            messages: await convertToModelMessages(parsed.request.messages),
            maxOutputTokens: agentMaxOutputTokens,
            stopWhen: stepCountIs(settings.agentMaxSteps),
            onFinish: async ({ totalUsage }) => {
              // The AI SDK swallows errors thrown from onFinish, so a failed ledger write must be logged here.
              try {
                await recordUsage(database, {
                  id: usageEventId,
                  userId: ctx.user.id,
                  counts: toTokenCounts(totalUsage),
                  price: admission.price,
                })
              } catch (error) {
                logger?.error(
                  { event: 'agent_usage_record_failed', ...logContext, error: getSafeLogMessage(error) },
                  'Agent usage record failed',
                )
              }
            },
            onError: ({ error }) => {
              // Name and status only: provider error messages and bodies can echo conversation content.
              // PostHog capture for the hosted agent is deferred to the usage/analytics follow-up (GTM-31).
              const errorName = error instanceof Error ? error.name : undefined
              const status = APICallError.isInstance(error) ? error.statusCode : undefined
              logger?.error({ event: 'agent_stream_failed', ...logContext, errorName, status }, 'Agent stream failed')
            },
          })
          // Run the model to completion even if the client disconnects, so the usage is always recorded.
          void result.consumeStream()
          return result.toUIMessageStreamResponse({ headers: streamingResponseHeaders(ctx.set.headers) })
        },
        // The handler reads the raw stream itself under a byte cap.
        { parse: 'none' },
      )
    })
}
