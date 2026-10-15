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
  stepCountIs,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type StepResult,
  type ToolSet,
} from 'ai'
import { Elysia, type AnyElysia } from 'elysia'
import type { Logger } from 'pino'
import { parseAgentChatRequest } from './history'
import { createAgentMcpClients, parseAgentMcpServers, type AgentMcpClients } from './mcp'
import { createAgentModel, getAgentIdentity, getAgentRequestHeaders } from './model'
import { createHostedAgentProvider } from './provider'
import { buildAgentSystemPrompt } from './system-prompt'
import { createToolTimingMetadata } from './tool-timing'
import { getAbortedRunCounts, getSettledRunCounts } from './usage-estimate'

/**
 * Longest output per model step. Generous for chat; with `AGENT_MAX_STEPS` it bounds the worst-case cost of a run,
 * since a run that calls tools makes one model call per step.
 */
export const agentMaxOutputTokens = 8192
/** Largest request body. Comfortably fits a long text conversation. */
export const maxRequestBytes = 2_000_000
/**
 * Longest a run may take, its tool calls included. It bounds how long a hung provider or MCP server can hold a
 * user's in-flight slot.
 */
export const agentUpstreamTimeoutMs = 120_000

/**
 * The last step's nudge once tools are withheld, so a run that is still calling tools at the cap answers instead
 * of ending on a call. The built-in pipeline does the same on its final step (`buildStepOverrides`,
 * `src/ai/step-logic.ts`).
 */
const finalStepNudge = 'RESPOND NOW with the information gathered. Do not ask questions.'

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
  /** Defaults to clients for the servers in `AGENT_MCP_SERVERS`, over `fetchFn`. */
  mcpClients?: AgentMcpClients
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

const createInstructionsTooLargeResponse = (): Response =>
  Response.json({ error: { code: 'AGENT_INSTRUCTIONS_TOO_LARGE' } }, { status: 400 })

/**
 * Hosted agent routes: `POST /agent/chat` takes a `DefaultChatTransport` body and streams a UI message
 * response. Stateless: the browser owns the conversation and resends it each turn. The run may call the read-only
 * tools of the MCP servers in `AGENT_MCP_SERVERS`, for at most `AGENT_MAX_STEPS` model steps, the last of which
 * offers no tools. Mounts nothing unless `AGENT_ENABLED` is set, and registers the agent with discovery.
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
  // Parsed at startup so a malformed AGENT_MCP_SERVERS fails the boot; the servers connect on first use.
  const mcpClients =
    options.mcpClients ?? createAgentMcpClients(parseAgentMcpServers(settings.agentMcpServers), { logger, fetchFn })
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
        if (!chatRequest.ok && chatRequest.reason === 'instructions_too_large') {
          logger?.info(
            { event: 'agent_instructions_too_large', provider: identity.provider, model: identity.model },
            'Agent request carried oversized instructions',
          )
          ctx.set.status = 400
          return createInstructionsTooLargeResponse()
        }
        if (!chatRequest.ok) {
          ctx.set.status = 400
          return createErrorResponse(getSafeErrorMessage(400))
        }
        const messages = await convertToModelMessages(chatRequest.value.messages)
        // Before admission: admission, the in-flight check and taking the slot must run back to back, and a first
        // connect can take seconds.
        const { tools, toolDefinitions, unavailableServers } = await mcpClients.loadTools()
        // A visitor who left while the tools loaded gets no run, so nothing is billed for a prompt never sent.
        if (ctx.request.signal.aborted) {
          return new Response(null, { status: 499 })
        }

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

        const hasTools = Object.keys(tools).length > 0
        const system = buildAgentSystemPrompt({
          operatorPrompt: settings.agentSystemPrompt,
          instructions: chatRequest.value.instructions,
          hasTools,
          unavailableServers,
          appLanguage: ctx.request.headers.get('X-App-Language'),
          timeZone: settings.agentTimezone,
          now: new Date(),
        })
        // Kept to bill an aborted run once it settles: the step in flight usually never reports usage, so it is
        // estimated from what it was sent and what it streamed, on top of what the finished steps reported.
        let streamedOutput = ''
        let finishedSteps: StepResult<ToolSet>[] = []
        let abortedRunUsage: LanguageModelUsage | undefined
        let abortReason: 'client' | 'timeout' | undefined

        const result = streamText({
          model,
          system,
          messages,
          tools,
          stopWhen: stepCountIs(settings.agentMaxSteps),
          // The last step offers no tools, so a run still calling them at the cap answers instead of stopping on a
          // call. A run without tools is left alone.
          prepareStep: ({ stepNumber, messages: stepMessages }) =>
            hasTools && stepNumber >= settings.agentMaxSteps - 1
              ? { activeTools: [], messages: [...stepMessages, { role: 'user', content: finalStepNudge }] }
              : undefined,
          headers: getAgentRequestHeaders(identity, userId),
          maxOutputTokens: agentMaxOutputTokens,
          // streamText merges the two: whichever fires first aborts the upstream call.
          abortSignal: ctx.request.signal,
          timeout: { totalMs: upstreamTimeoutMs },
          onChunk: ({ chunk }) => {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
              streamedOutput += chunk.text
            }
            if (chunk.type === 'tool-input-delta') {
              streamedOutput += chunk.delta
            }
          },
          onStepFinish: () => {
            streamedOutput = ''
          },
          onFinish: ({ totalUsage, steps }) => {
            // After an abort, recordAbortedRunUsage writes the run's one row. Deferring to it here is the first
            // guard against a second row; the ledger's idempotent insert (onConflictDoNothing on the run's
            // eventId, in recordInferenceUsage) is the second, but it alone would keep whichever write landed first.
            if (abortReason) {
              abortedRunUsage = totalUsage
              return
            }
            const counts = getSettledRunCounts(
              totalUsage,
              steps.map(({ usage }) => usage),
            )
            return counts
              ? recordTokenCounts(usageCallbacks, counts)
              : recordLanguageModelUsage(usageCallbacks, totalUsage)
          },
          onError: ({ error }) => logRunFailure(error),
          // A client disconnect (Stop, or a dropped connection) or the timeout aborts the run without reaching
          // onError. onAbort runs first, with the steps that finished. onFinish follows once any step had finished,
          // with the run's total only when the abort landed after its last step.
          onAbort: ({ steps }) => {
            finishedSteps = steps
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
            finishedSteps: finishedSteps.map(({ usage }) => usage),
            system,
            toolDefinitions,
            // A step's response messages are cumulative: the last finished step's hold every earlier step's too.
            messages: [...messages, ...(finishedSteps.at(-1)?.response.messages ?? [])],
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
          messageMetadata: createToolTimingMetadata(),
        })
      },
      // The handler reads the raw stream itself under a byte cap.
      { parse: 'none' },
    )
}
