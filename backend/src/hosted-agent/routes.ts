/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { rejectUnregisteredCliDevice } from '@/inference/cli-device'
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
import { registerAgentProvider } from '@/agents'
import { readBodyWithinLimit } from '@/utils/request-body'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  APICallError,
  convertToModelMessages,
  RetryError,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
} from 'ai'
import { Elysia, type AnyElysia } from 'elysia'
import type { Logger } from 'pino'
import { parseAgentChatRequest } from './history'
import { createHostedAgentProvider } from './provider'

/** Longest reply per run. Generous for chat, and it bounds the worst-case cost of a single run. */
export const agentMaxOutputTokens = 8192
/** Largest request body. Comfortably fits a long conversation with a few inline images. */
export const maxRequestBytes = 2_000_000
/** Longest a run may take upstream. It bounds how long a hung provider can hold a user's in-flight slot. */
export const agentUpstreamTimeoutMs = 120_000

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
  /** Defaults to `agentUpstreamTimeoutMs`. */
  upstreamTimeoutMs?: number
}

/** Map AI SDK usage, summed across steps, onto the ledger's token counts; null when the provider sent none. */
const toTokenCounts = (usage: LanguageModelUsage): InferenceTokenCounts | null => {
  if (usage.inputTokens === undefined) {
    return null
  }
  const completionTokens = usage.outputTokens ?? 0
  return {
    promptTokens: usage.inputTokens,
    completionTokens,
    totalTokens: usage.inputTokens + completionTokens,
    cacheCreationTokens: usage.inputTokenDetails.cacheWriteTokens,
    cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
  }
}

/** Upstream HTTP status of a failed run. Retried failures arrive wrapped in a `RetryError`. */
const getUpstreamStatus = (error: unknown): number | undefined => {
  const cause = RetryError.isInstance(error) ? error.lastError : error
  return APICallError.isInstance(cause) ? cause.statusCode : undefined
}

const createRunInProgressResponse = (): Response =>
  Response.json({ error: { code: 'AGENT_RUN_IN_PROGRESS' } }, { status: 429 })

/**
 * Hosted agent routes: `POST /agent/chat` takes a `DefaultChatTransport` body and streams a UI message
 * response. Stateless: the browser owns the conversation and resends it each turn. Mounts nothing unless
 * `AGENT_ENABLED` is set, and registers the agent with discovery.
 */
export const createHostedAgentRoutes = (options: CreateHostedAgentRoutesOptions) => {
  const { auth, database, settings, logger, rateLimit } = options
  // Registered even when disabled, like Haystack: the provider itself emits nothing without `AGENT_ENABLED`.
  registerAgentProvider(createHostedAgentProvider())
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
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? agentUpstreamTimeoutMs
  const identity: ManagedInferenceIdentity = { provider: 'anthropic', model: settings.agentModel }
  const system = settings.agentSystemPrompt || undefined
  const model =
    options.model ??
    createAnthropic({
      apiKey: settings.anthropicApiKey,
      baseURL: `${settings.anthropicBaseUrl.replace(/\/$/, '')}/v1`,
    })(settings.agentModel)
  // Admission only sees settled ledger rows, so concurrent runs would each be admitted at the same spend.
  // One run per user closes that gap. The set is per process, which is sufficient while the agent runs
  // as a single instance; a multi-instance deployment needs a shared lock.
  const usersWithRunInFlight = new Set<string>()

  return new Elysia({ name: 'hosted-agent-routes', prefix: '/agent' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (guardedApp) => {
      guardedApp.onBeforeHandle(({ request, session, user }) =>
        rejectUnregisteredCliDevice(database, settings.cliDeviceRegistrationEnabled, { request, session, user }),
      )
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
          const chatRequest = parseAgentChatRequest(rawBody)
          if (!chatRequest) {
            ctx.set.status = 400
            return createErrorResponse(getSafeErrorMessage(400))
          }
          const messages = await convertToModelMessages(chatRequest.messages)

          const userId = ctx.user.id
          const admission = await checkAdmission(
            database,
            identity,
            userId,
            getInferenceQuotaLimits(settings, ctx.user.isAnonymous === true),
          )
          if (admission.outcome === 'price-unavailable') {
            return createPriceUnavailableResponse()
          }
          if (admission.outcome === 'quota-exceeded') {
            return createQuotaExceededResponse(admission.decision)
          }
          if (usersWithRunInFlight.has(userId)) {
            return createRunInProgressResponse()
          }

          const usageEventId = crypto.randomUUID()
          const logContext = { provider: identity.provider, model: identity.model, eventId: usageEventId }
          /** Name and status only: provider error messages and bodies can echo conversation content. */
          const logRunFailure = (error: unknown) => {
            // PostHog capture for the hosted agent is deferred to the usage/analytics follow-up (GTM-31).
            const errorName = error instanceof Error ? error.name : undefined
            logger?.error(
              { event: 'agent_stream_failed', ...logContext, errorName, status: getUpstreamStatus(error) },
              'Agent stream failed',
            )
          }

          const result = streamText({
            model,
            system,
            messages,
            maxOutputTokens: agentMaxOutputTokens,
            timeout: { totalMs: upstreamTimeoutMs },
            onFinish: async ({ totalUsage }) => {
              const counts = toTokenCounts(totalUsage)
              if (!counts) {
                logger?.error({ event: 'agent_usage_missing', ...logContext }, 'Agent usage missing')
                return
              }
              // The AI SDK swallows errors thrown from onFinish, so a failed ledger write must be logged here.
              try {
                await recordUsage(database, { id: usageEventId, userId, counts, price: admission.price })
              } catch (error) {
                logger?.error(
                  { event: 'agent_usage_record_failed', ...logContext, error: getSafeLogMessage(error) },
                  'Agent usage record failed',
                )
              }
            },
            onError: ({ error }) => logRunFailure(error),
            // A timeout aborts the run without reaching onError. It is the only abort source: the client's
            // disconnect is deliberately not wired in, so the run (and its usage) outlives the socket.
            onAbort: () => {
              logger?.error({ event: 'agent_run_timed_out', ...logContext, upstreamTimeoutMs }, 'Agent run timed out')
            },
          })
          // Drive the run to completion even if the client disconnects, so usage is recorded. consumeStream
          // settles after onFinish, on a stream error, or once an abandoned run ends, so the slot is always
          // released.
          const runToCompletion = async () => {
            try {
              await result.consumeStream({ onError: logRunFailure })
            } finally {
              usersWithRunInFlight.delete(userId)
            }
          }
          // Taken only now, right before the run that releases it, so nothing in between can leave the slot held.
          usersWithRunInFlight.add(userId)
          void runToCompletion()
          return result.toUIMessageStreamResponse({ headers: streamingResponseHeaders(ctx.set.headers) })
        },
        // The handler reads the raw stream itself under a byte cap.
        { parse: 'none' },
      )
    })
}
