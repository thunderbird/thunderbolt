/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { genAiAttributes as attr, genAiOperationExecuteTool, genAiOperationInvokeAgent } from '@shared/telemetry/gen-ai'
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, isSpanContextValid, trace, type Tracer } from '@opentelemetry/api'
import { v7 as uuidv7 } from 'uuid'

export type TurnEngine = 'pi' | 'legacy'
export type TurnOutcome = 'success' | 'error' | 'abort'
export type TurnRetryLayer = 'auto_retry' | 'empty_response' | 'turn_budget'
export type ToolCallValidationFailureKind = 'no_such_tool' | 'invalid_tool_input' | 'other'
export type TurnPhase =
  | 'persist_user_message'
  | 'adapter_connect'
  | 'agent_core_load'
  | 'request_config'
  | 'mcp_discovery'
  | 'harness_build'
  | 'attestation'
  | 'attachment_hydration'
  | 'final_save'

export type TurnToolTiming = {
  name: string
  duration_ms: number
}

export type TurnTelemetryPayload = Record<string, string | number | boolean | string[] | TurnToolTiming[] | undefined>

export type TurnTelemetry = {
  readonly traceId: string
  /** W3C `traceparent` of the turn span, sent only to our managed chat routes; undefined without a tracer provider. */
  readonly traceparent: string | undefined
  getEngine: () => TurnEngine | undefined
  setDimensions: (dimensions: { engine?: TurnEngine; modelId?: string; modelName?: string; provider?: string }) => void
  startPhase: (name: TurnPhase) => void
  endPhase: (name: TurnPhase) => void
  markFirstToken: () => void
  recordRetry: (retry: { layer: TurnRetryLayer; reason: string; attempt: number }) => void
  recordStep: () => void
  recordTool: (toolName: string, durationMs: number, failed?: boolean) => void
  recordToolCallValidationFailure: (kind: ToolCallValidationFailureKind) => void
  recordError: (errorClass: string) => void
  buildPayload: (outcome: TurnOutcome) => TurnTelemetryPayload
  /** End the `invoke_agent` turn span; call once, after the last `recordTool`. */
  endSpan: (outcome: TurnOutcome) => void
}

type CreateTurnTelemetryOptions = {
  now?: () => number
  generateId?: () => string
  tracer?: Tracer
}

const roundDuration = (durationMs: number): number => Math.max(0, Math.round(durationMs))
const toolCallValidationFailureKindOrder: readonly ToolCallValidationFailureKind[] = [
  'no_such_tool',
  'invalid_tool_input',
  'other',
]

/** Create a privacy-safe recorder for one logical built-in agent turn. */
export const createTurnTelemetry = ({
  now = () => performance.now(),
  generateId = uuidv7,
  tracer = trace.getTracer('thunderbolt'),
}: CreateTurnTelemetryOptions = {}): TurnTelemetry => {
  const span = tracer.startSpan(`${genAiOperationInvokeAgent} thunderbolt`, {
    kind: SpanKind.INTERNAL,
    attributes: { [attr.operationName]: genAiOperationInvokeAgent, [attr.agentName]: 'thunderbolt' },
  })
  const spanContext = span.spanContext()
  const hasSpan = isSpanContextValid(spanContext)
  // The span's trace id doubles as `trace_id`, so PostHog events and spans join on one value.
  const traceId = hasSpan ? spanContext.traceId : generateId()
  const traceparent = hasSpan
    ? `00-${traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, '0')}`
    : undefined
  const spanParent = trace.setSpan(ROOT_CONTEXT, span)
  const startedAt = now()
  const phaseStarts = new Map<TurnPhase, number>()
  const phaseDurations = new Map<TurnPhase, number>()
  const retryLayers = new Set<TurnRetryLayer>()
  const retryReasons = new Set<string>()
  const toolCallValidationFailureKinds = new Set<ToolCallValidationFailureKind>()
  const tools: TurnToolTiming[] = []
  const dimensions: {
    engine?: TurnEngine
    modelId?: string
    modelName?: string
    provider?: string
  } = {}
  let firstTokenAt: number | undefined
  let errorClass: string | undefined
  let attempts = 1
  let stepCount = 0
  let toolCount = 0
  let toolCallValidationFailureCount = 0

  const recordPhase = (name: TurnPhase, durationMs: number) => {
    phaseDurations.set(name, (phaseDurations.get(name) ?? 0) + roundDuration(durationMs))
  }

  return {
    traceId,
    traceparent,
    getEngine: () => dimensions.engine,
    setDimensions: (nextDimensions) => {
      dimensions.engine = nextDimensions.engine ?? dimensions.engine
      dimensions.modelId ??= nextDimensions.modelId
      dimensions.modelName ??= nextDimensions.modelName
      dimensions.provider ??= nextDimensions.provider
    },
    startPhase: (name) => phaseStarts.set(name, now()),
    endPhase: (name) => {
      const phaseStartedAt = phaseStarts.get(name)
      if (phaseStartedAt === undefined) {
        return
      }
      phaseStarts.delete(name)
      recordPhase(name, now() - phaseStartedAt)
    },
    markFirstToken: () => {
      firstTokenAt ??= now()
    },
    recordRetry: ({ layer, reason, attempt }) => {
      retryLayers.add(layer)
      retryReasons.add(reason)
      attempts = Math.max(attempts, attempt)
    },
    recordStep: () => {
      stepCount++
    },
    recordTool: (name, durationMs, failed = false) => {
      const endedAt = now()
      tracer
        .startSpan(
          `${genAiOperationExecuteTool} ${name}`,
          {
            kind: SpanKind.INTERNAL,
            // A child must not start before its parent turn span.
            startTime: Math.max(startedAt, endedAt - durationMs),
            attributes: {
              [attr.operationName]: genAiOperationExecuteTool,
              [attr.toolName]: name,
              [attr.toolType]: 'function',
              [attr.errorType]: failed ? 'tool_error' : undefined,
            },
          },
          spanParent,
        )
        .end(endedAt)
      toolCount++
      if (tools.length < 20) {
        tools.push({ name, duration_ms: roundDuration(durationMs) })
      }
    },
    recordToolCallValidationFailure: (kind) => {
      toolCallValidationFailureCount++
      toolCallValidationFailureKinds.add(kind)
    },
    recordError: (nextErrorClass) => {
      errorClass = nextErrorClass
    },
    buildPayload: (outcome) => {
      const phasePayload = Object.fromEntries(
        [...phaseDurations].map(([name, durationMs]) => [`${name}_ms`, durationMs]),
      )
      const payload: TurnTelemetryPayload = {
        trace_id: traceId,
        engine: dimensions.engine,
        model_id: dimensions.modelId,
        model_name: dimensions.modelName,
        provider: dimensions.provider,
        outcome,
        error_class: outcome === 'error' ? errorClass : undefined,
        attempts,
        retry_layers: [...retryLayers],
        retry_reasons: [...retryReasons],
        ...phasePayload,
        ttft_ms: firstTokenAt === undefined ? undefined : roundDuration(firstTokenAt - startedAt),
        step_count: stepCount,
        tool_count: toolCount,
        tools,
        tool_call_validation_failure_count:
          toolCallValidationFailureCount === 0 ? undefined : toolCallValidationFailureCount,
        tool_call_validation_failure_kinds:
          toolCallValidationFailureCount === 0
            ? undefined
            : toolCallValidationFailureKindOrder.filter((kind) => toolCallValidationFailureKinds.has(kind)),
        total_ms: roundDuration(now() - startedAt),
      }
      return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
    },
    endSpan: (outcome) => {
      span.setAttributes({
        [attr.requestModel]: dimensions.modelName,
        [attr.providerName]: dimensions.provider,
        [attr.thunderboltEngine]: dimensions.engine,
        [attr.thunderboltOutcome]: outcome,
      })
      if (outcome === 'error') {
        span.setAttribute(attr.errorType, errorClass ?? '_OTHER')
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
      span.end()
    },
  }
}
