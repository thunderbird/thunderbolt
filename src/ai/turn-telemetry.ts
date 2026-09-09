/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
  getEngine: () => TurnEngine | undefined
  setDimensions: (dimensions: { engine?: TurnEngine; modelId?: string; modelName?: string; provider?: string }) => void
  startPhase: (name: TurnPhase) => void
  endPhase: (name: TurnPhase) => void
  markFirstToken: () => void
  recordRetry: (retry: { layer: TurnRetryLayer; reason: string; attempt: number }) => void
  recordStep: () => void
  recordTool: (toolName: string, durationMs: number) => void
  recordToolCallValidationFailure: (kind: ToolCallValidationFailureKind) => void
  recordError: (errorClass: string) => void
  buildPayload: (outcome: TurnOutcome) => TurnTelemetryPayload
}

type CreateTurnTelemetryOptions = {
  now?: () => number
  generateId?: () => string
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
}: CreateTurnTelemetryOptions = {}): TurnTelemetry => {
  const traceId = generateId()
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
    recordTool: (name, durationMs) => {
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
  }
}
