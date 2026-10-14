/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import {
  admitManagedRequest,
  createUsageCallbacks,
  recordLanguageModelUsage,
  recordTokenCounts,
} from '@/inference/managed-request'
import { createMeteredRouteGuard } from '@/inference/metered-route-guard'
import { streamingResponseHeaders } from '@/inference/routes'
import type { checkManagedInferenceAdmission, InferenceDatabase, recordInferenceUsage } from '@/inference/usage-ledger'
import {
  createErrorResponse,
  getSafeErrorMessage,
  getSafeLogMessage,
  safeErrorHandler,
} from '@/middleware/error-handling'
import { registerAgentProvider } from '@/agents'
import { readBoundedJson } from '@/utils/request-body'
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
import { createAgentModel, getAgentIdentity, getAgentRequestHeaders } from './model'
import { createHostedAgentProvider } from './provider'
import { buildAgentSystemPrompt } from './system-prompt'
import { getAbortedRunCounts } from './usage-estimate'

/** Longest reply per run. Generous for chat, and it bounds the worst-case cost of a single run. */
export const agentMaxOutputTokens = 8192
/** Largest request body. Comfortably fits a long text conversation. */
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
  /** Defaults to `AGENT_MODEL` on the managed key of its provider (see `getAgentIdentity`). */
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

const createFilesUnsupportedResponse = (): Response =>
  Response.json({ error: { code: 'AGENT_FILES_UNSUPPORTED' } }, { status: 400 })

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
  const identity = getAgentIdentity(settings.agentModel)
  // Built at startup so an unset provider key fails the boot (see `createManagedProviderConnection`).
  const model = options.model ?? createAgentModel(identity, settings, { fetchFn, logger })
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
        allowPersonalAccessTokens: true,
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
        const chatRequest = body.ok ? parseAgentChatRequest(body.value) : ({ ok: false, reason: 'invalid' } as const)
        if (!chatRequest.ok && chatRequest.reason === 'files_unsupported') {
          logger?.info(
            { event: 'agent_files_unsupported', provider: identity.provider, model: identity.model },
            'Agent request carried file parts',
          )
          ctx.set.status = 400
          return createFilesUnsupportedResponse()
        }
        if (!chatRequest.ok) {
          ctx.set.status = 400
          return createErrorResponse(getSafeErrorMessage(400))
        }
        const messages = await convertToModelMessages(chatRequest.value.messages)

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

        const system = buildAgentSystemPrompt({
          operatorPrompt: settings.agentSystemPrompt,
          appLanguage: ctx.request.headers.get('X-App-Language'),
          timeZone: settings.agentTimezone,
          now: new Date(),
        })
        // Kept to bill an aborted run once it settles: it usually never reports usage, so it is estimated from
        // what was sent and what streamed back.
        let streamedOutput = ''
        let abortedRunUsage: LanguageModelUsage | undefined
        let abortReason: 'client' | 'timeout' | undefined

        const result = streamText({
          model,
          system,
          messages,
          headers: getAgentRequestHeaders(identity, userId),
          maxOutputTokens: agentMaxOutputTokens,
          // streamText merges the two: whichever fires first aborts the upstream call.
          abortSignal: ctx.request.signal,
          timeout: { totalMs: upstreamTimeoutMs },
          onChunk: ({ chunk }) => {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
              streamedOutput += chunk.text
            }
          },
          onFinish: ({ totalUsage }) => {
            // After an abort, recordAbortedRunUsage writes the run's one row. Deferring to it here is the first
            // guard against a second row; the ledger's idempotent insert (onConflictDoNothing on the run's
            // eventId, in recordInferenceUsage) is the second, but it alone would keep whichever write landed first.
            if (abortReason) {
              abortedRunUsage = totalUsage
              return
            }
            return recordLanguageModelUsage(usageCallbacks, totalUsage)
          },
          onError: ({ error }) => logRunFailure(error),
          // A client disconnect (Stop, or a dropped connection) or the timeout aborts the run without reaching
          // onError. onAbort runs first; onFinish follows only when the abort lands after the run's last step.
          onAbort: () => {
            abortReason = ctx.request.signal.aborted ? 'client' : 'timeout'
            if (abortReason === 'client') {
              logger?.info({ event: 'agent_run_aborted', ...logContext }, 'Agent run aborted by the client')
              return
            }
            logger?.error({ event: 'agent_run_timed_out', ...logContext, upstreamTimeoutMs }, 'Agent run timed out')
          },
        })
        /** Bill an aborted run once every stream callback has run; see `getAbortedRunCounts`. */
        const recordAbortedRunUsage = async (reason: 'client' | 'timeout') => {
          const { counts, estimated } = getAbortedRunCounts({
            reportedUsage: abortedRunUsage,
            system,
            messages,
            outputText: streamedOutput,
          })
          if (estimated) {
            logger?.info(
              {
                event: 'agent_usage_estimated',
                ...logContext,
                reason,
                promptTokens: counts.promptTokens,
                completionTokens: counts.completionTokens,
              },
              'Agent usage estimated',
            )
          }
          await recordTokenCounts(usageCallbacks, counts)
        }
        // Read the run on the server so it settles and is billed whether or not the client reads the response.
        // consumeStream settles after onFinish, on a stream error, or once an abort ends the run, so the slot
        // is always released, after the run's usage is written.
        const runToCompletion = async () => {
          try {
            await result.consumeStream({ onError: logRunFailure })
            if (abortReason) {
              await recordAbortedRunUsage(abortReason)
            }
          } finally {
            usersWithRunInFlight.delete(userId)
          }
        }
        // Taken only now, right before the run that releases it, so nothing in between can leave the slot held.
        usersWithRunInFlight.add(userId)
        void runToCompletion()
        // Reasoning stays server-side: it can paraphrase the system prompt, and anonymous visitors read the stream.
        return result.toUIMessageStreamResponse({
          headers: streamingResponseHeaders(ctx.set.headers),
          sendReasoning: false,
        })
      },
      // The handler reads the raw stream itself under a byte cap.
      { parse: 'none' },
    )
}
