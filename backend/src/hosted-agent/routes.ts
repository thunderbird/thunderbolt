/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { createManagedProviderConnection } from '@/inference/client'
import { admitManagedRequest, createUsageCallbacks, recordLanguageModelUsage } from '@/inference/managed-request'
import { createMeteredRouteGuard } from '@/inference/metered-route-guard'
import { streamingResponseHeaders } from '@/inference/routes'
import type {
  checkManagedInferenceAdmission,
  InferenceDatabase,
  ManagedInferenceIdentity,
  recordInferenceUsage,
} from '@/inference/usage-ledger'
import {
  createErrorResponse,
  getSafeErrorMessage,
  getSafeLogMessage,
  safeErrorHandler,
} from '@/middleware/error-handling'
import { registerAgentProvider } from '@/agents'
import { readBoundedJson } from '@/utils/request-body'
import { createAnthropic } from '@ai-sdk/anthropic'
import { APICallError, convertToModelMessages, RetryError, streamText, type LanguageModel } from 'ai'
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
  /** Upstream fetch for the default model; tests pass a stub, like the other route groups. */
  fetchFn?: typeof fetch
  logger?: Pick<Logger, 'error' | 'info'>
  rateLimit?: AnyElysia
  /** Defaults to `AGENT_MODEL` on the managed Anthropic key. */
  model?: LanguageModel
  checkAdmission?: typeof checkManagedInferenceAdmission
  recordUsage?: typeof recordInferenceUsage
  /** Defaults to `agentUpstreamTimeoutMs`. */
  upstreamTimeoutMs?: number
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
  const { auth, database, settings, fetchFn, logger, rateLimit, checkAdmission, recordUsage } = options
  // Registered even when disabled, like Haystack: the provider itself emits nothing without `AGENT_ENABLED`.
  registerAgentProvider(createHostedAgentProvider())
  if (!settings.agentEnabled) {
    return new Elysia({ name: 'hosted-agent-routes' })
  }
  if (!settings.agentModel) {
    throw new Error('AGENT_MODEL is required when AGENT_ENABLED is true')
  }

  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? agentUpstreamTimeoutMs
  const identity: ManagedInferenceIdentity = { provider: 'anthropic', model: settings.agentModel }
  const system = settings.agentSystemPrompt || undefined
  // Built here, at startup, so an unset ANTHROPIC_API_KEY fails the boot rather than the first request.
  const model =
    options.model ??
    createAnthropic(createManagedProviderConnection('anthropic', settings, { fetchFn, logger, source: 'agent' }))(
      settings.agentModel,
    )
  // Admission only sees settled ledger rows, so concurrent runs would each be admitted at the same spend.
  // One run per user closes that gap. The set is per process, which is sufficient while the agent runs
  // as a single instance; a multi-instance deployment needs a shared lock.
  const usersWithRunInFlight = new Set<string>()

  return new Elysia({ name: 'hosted-agent-routes', prefix: '/agent' })
    .onError(safeErrorHandler)
    .use(
      createMeteredRouteGuard({
        auth,
        database,
        cliDeviceRegistrationEnabled: settings.cliDeviceRegistrationEnabled,
        rateLimit,
      }),
    )
    .post(
      '/chat',
      async (ctx) => {
        const body = await readBoundedJson(ctx.request, maxRequestBytes)
        if (!body.ok && body.reason === 'too_large') {
          ctx.set.status = 413
          return createErrorResponse(getSafeErrorMessage(413))
        }
        const chatRequest = body.ok ? parseAgentChatRequest(body.value) : null
        if (!chatRequest) {
          ctx.set.status = 400
          return createErrorResponse(getSafeErrorMessage(400))
        }
        const messages = await convertToModelMessages(chatRequest.messages)

        const userId = ctx.user.id
        const admission = await admitManagedRequest({
          database,
          settings,
          identity,
          user: ctx.user,
          set: ctx.set,
          logger,
          checkAdmission,
        })
        if (admission instanceof Response) {
          return admission
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
        const usageCallbacks = createUsageCallbacks({
          database,
          eventId: usageEventId,
          userId,
          price: admission.price,
          recordUsage,
          telemetry: {
            onUsageMissing: () => logger?.error({ event: 'agent_usage_missing', ...logContext }, 'Agent usage missing'),
            onUsageError: (error) =>
              logger?.error(
                { event: 'agent_usage_record_failed', ...logContext, error: getSafeLogMessage(error) },
                'Agent usage record failed',
              ),
          },
        })

        const result = streamText({
          model,
          system,
          messages,
          maxOutputTokens: agentMaxOutputTokens,
          timeout: { totalMs: upstreamTimeoutMs },
          onFinish: ({ totalUsage }) => recordLanguageModelUsage(usageCallbacks, totalUsage),
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
}
