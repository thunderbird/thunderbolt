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
import type {
  checkManagedInferenceAdmission,
  InferenceDatabase,
  InferencePrice,
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
import { finalStepNudge } from '@shared/final-step-nudge'
import {
  APICallError,
  convertToModelMessages,
  RetryError,
  stepCountIs,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from 'ai'
import { Elysia, type AnyElysia } from 'elysia'
import type { Logger } from 'pino'
import { parseAgentChatRequest } from './history'
import { createAgentMcpClients, parseAgentMcpServers, type AgentMcpClients, type AgentMcpToolsResult } from './mcp'
import { createAgentModel, getAgentIdentity, getAgentRequestHeaders } from './model'
import { assertServiceTierPriced, priceForServiceTier } from './pricing'
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
 * Time kept for a run's last step. Once a run has used all but this much of its timeout, its next step offers no
 * tools and answers, so slow tool calls cannot run a reply into the timeout with nothing said.
 */
export const finalStepReserveMs = 30_000

/** The last step's nudge once tools are withheld, worded as the built-in pipeline's (see `finalStepNudge`). */
const finalStepMessage: ModelMessage = { role: 'user', content: finalStepNudge }

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

/** A request ready to run: its user's slot taken and its tools loaded. */
type AgentRunRequest = {
  userId: string
  price: InferencePrice
  messages: ModelMessage[]
  /** The request's `instructions`, when it carried any. */
  instructions?: string
  /** Raw `X-App-Language` header value, or null when absent. */
  appLanguage: string | null
  /** The request's own, which aborts when the visitor leaves. */
  signal: AbortSignal
  /** Headers the route has set, sent with the stream. */
  responseHeaders: object
  loaded: AgentMcpToolsResult
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
 * offers no tools; a run that spends its call budget or nears its timeout takes that last step early. Mounts nothing
 * unless `AGENT_ENABLED` is set, and registers the agent with discovery.
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
  assertServiceTierPriced(identity, settings)
  // Built at startup so an unset provider key fails the boot (see `createManagedProviderConnection`).
  const model = options.model ?? createAgentModel(identity, settings, { fetchFn, logger })
  // Parsed at startup so a malformed AGENT_MCP_SERVERS fails the boot; the servers connect on first use.
  const mcpClients =
    options.mcpClients ?? createAgentMcpClients(parseAgentMcpServers(settings.agentMcpServers), { logger, fetchFn })
  // Admission only sees settled ledger rows, so concurrent runs would each be admitted at the same spend.
  // One run per user closes that gap. The set is per process, which is sufficient while the agent runs
  // as a single instance; a multi-instance deployment needs a shared lock.
  const usersWithRunInFlight = new Set<string>()

  /**
   * Start a run for a request that holds its user's slot, and return its stream. The run releases the slot once it
   * settles, after its usage is written.
   */
  const startRun = ({
    userId,
    price,
    messages,
    instructions,
    appLanguage,
    signal,
    responseHeaders,
    loaded: { tools, toolDefinitions, unavailableServers, isCallBudgetSpent },
  }: AgentRunRequest): Response => {
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
      price,
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
    const startedAt = Date.now()
    // The last step offers no tools, so a run still calling them answers instead of stopping on a call: the step at
    // the cap, the one after the call budget is spent, and whichever starts once the run is near its timeout. A run
    // without tools is left alone.
    const isFinalStep = (stepNumber: number) =>
      hasTools &&
      (stepNumber >= settings.agentMaxSteps - 1 ||
        isCallBudgetSpent() ||
        Date.now() - startedAt >= upstreamTimeoutMs - finalStepReserveMs)
    const system = buildAgentSystemPrompt({
      operatorPrompt: settings.agentSystemPrompt,
      instructions,
      hasTools,
      unavailableServers,
      appLanguage,
      timeZone: settings.agentTimezone,
      now: new Date(),
    })
    // Kept to bill an aborted run once it settles: the step in flight usually never reports usage, so it is
    // estimated from what it was sent and what it streamed, on top of what the finished steps reported.
    let streamedOutput = ''
    let finishedSteps: StepResult<ToolSet>[] = []
    let abortedRunUsage: LanguageModelUsage | undefined
    let abortReason: 'client' | 'timeout' | undefined
    // Recorded rather than recomputed, since the time and the calls spent have moved on by the time a run aborts.
    let finalStepNumber: number | undefined

    const result = streamText({
      model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(settings.agentMaxSteps),
      prepareStep: ({ stepNumber, messages: stepMessages }) => {
        if (!isFinalStep(stepNumber)) {
          return undefined
        }
        finalStepNumber = stepNumber
        return { activeTools: [], messages: [...stepMessages, finalStepMessage] }
      },
      headers: getAgentRequestHeaders(identity, userId),
      maxOutputTokens: agentMaxOutputTokens,
      // streamText merges the two: whichever fires first aborts the upstream call.
      abortSignal: signal,
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
        return counts ? recordTokenCounts(usageCallbacks, counts) : recordLanguageModelUsage(usageCallbacks, totalUsage)
      },
      onError: ({ error }) => logRunFailure(error),
      // A client disconnect (Stop, or a dropped connection) or the timeout aborts the run without reaching
      // onError. onAbort runs first, with the steps that finished. onFinish follows once any step had finished,
      // with the run's total only when the abort landed after its last step.
      onAbort: ({ steps }) => {
        finishedSteps = steps
        abortReason = signal.aborted ? 'client' : 'timeout'
        if (abortReason === 'client') {
          logger?.info({ event: 'agent_run_aborted', ...logContext }, 'Agent run aborted by the client')
          return
        }
        logger?.error({ event: 'agent_run_timed_out', ...logContext, upstreamTimeoutMs }, 'Agent run timed out')
      },
    })
    /** Bill an aborted run once every stream callback has run; see `getAbortedRunCounts`. */
    const recordAbortedRunUsage = async (reason: 'client' | 'timeout') => {
      // The step in flight follows the ones that finished. The final step was sent the nudge, not the tools.
      const wasFinalStep = finalStepNumber === finishedSteps.length
      const { counts, estimated } = getAbortedRunCounts({
        reportedUsage: abortedRunUsage,
        finishedSteps: finishedSteps.map(({ usage }) => usage),
        system,
        toolDefinitions: wasFinalStep ? '' : toolDefinitions,
        // A step's response messages are cumulative: the last finished step's hold every earlier step's too.
        messages: [
          ...messages,
          ...(finishedSteps.at(-1)?.response.messages ?? []),
          ...(wasFinalStep ? [finalStepMessage] : []),
        ],
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
    // Reasoning stays server-side: it can paraphrase the system prompt, and anonymous visitors read the stream.
    const response = result.toUIMessageStreamResponse({
      headers: streamingResponseHeaders(responseHeaders),
      sendReasoning: false,
      messageMetadata: createToolTimingMetadata(),
    })
    // Last, so the run takes the slot over only once nothing here can throw.
    void runToCompletion()
    return response
  }

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
        // Taken in the same tick as the check, so while this request loads its tools, another from the same user is
        // refused before it reaches an MCP server. The run releases it once it starts; until then, this does.
        usersWithRunInFlight.add(userId)
        try {
          const loaded = await mcpClients.loadTools(ctx.request.signal)
          // A visitor who left while the tools loaded gets no run, so nothing is billed for a prompt never sent.
          if (ctx.request.signal.aborted) {
            usersWithRunInFlight.delete(userId)
            return new Response(null, { status: 499 })
          }
          return startRun({
            userId,
            price: priceForServiceTier(admission.price, settings),
            messages,
            instructions: chatRequest.value.instructions,
            appLanguage: ctx.request.headers.get('X-App-Language'),
            signal: ctx.request.signal,
            responseHeaders: ctx.set.headers,
            loaded,
          })
        } catch (error) {
          usersWithRunInFlight.delete(userId)
          throw error
        }
      },
      // The handler reads the raw stream itself under a byte cap.
      { parse: 'none' },
    )
}
