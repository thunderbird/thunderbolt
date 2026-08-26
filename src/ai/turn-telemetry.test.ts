/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createTurnTelemetry } from './turn-telemetry'

describe('createTurnTelemetry', () => {
  it('creates a unique trace for each turn', () => {
    const ids = ['trace-1', 'trace-2']
    const generateId = () => ids.shift()!

    expect(createTurnTelemetry({ generateId }).traceId).toBe('trace-1')
    expect(createTurnTelemetry({ generateId }).traceId).toBe('trace-2')
  })

  it('omits tool call validation properties when there are no failures', () => {
    const telemetry = createTurnTelemetry({ now: () => 0, generateId: () => 'trace-1' })

    const payload = telemetry.buildPayload('success')

    expect(payload).not.toHaveProperty('tool_call_validation_failure_count')
    expect(payload).not.toHaveProperty('tool_call_validation_failure_kinds')
  })

  it('counts every tool call validation failure occurrence', () => {
    const telemetry = createTurnTelemetry({ now: () => 0, generateId: () => 'trace-1' })

    telemetry.recordToolCallValidationFailure('invalid_tool_input')
    telemetry.recordToolCallValidationFailure('invalid_tool_input')
    telemetry.recordToolCallValidationFailure('no_such_tool')

    expect(telemetry.buildPayload('success').tool_call_validation_failure_count).toBe(3)
  })

  it('deduplicates repeated tool call validation failure kinds', () => {
    const telemetry = createTurnTelemetry({ now: () => 0, generateId: () => 'trace-1' })

    telemetry.recordToolCallValidationFailure('invalid_tool_input')
    telemetry.recordToolCallValidationFailure('invalid_tool_input')

    expect(telemetry.buildPayload('success').tool_call_validation_failure_kinds).toEqual(['invalid_tool_input'])
  })

  it('emits tool call validation failure kinds in canonical order', () => {
    const telemetry = createTurnTelemetry({ now: () => 0, generateId: () => 'trace-1' })

    telemetry.recordToolCallValidationFailure('other')
    telemetry.recordToolCallValidationFailure('invalid_tool_input')
    telemetry.recordToolCallValidationFailure('no_such_tool')

    expect(telemetry.buildPayload('success').tool_call_validation_failure_kinds).toEqual([
      'no_such_tool',
      'invalid_tool_input',
      'other',
    ])
  })

  it('records whole-millisecond phase, TTFT, retry, step, and tool timings', () => {
    let currentTime = 10
    const telemetry = createTurnTelemetry({ now: () => currentTime, generateId: () => 'trace-1' })

    telemetry.setDimensions({ engine: 'pi', modelId: 'model-1', modelName: 'claude', provider: 'anthropic' })
    telemetry.startPhase('request_config')
    currentTime = 14.6
    telemetry.endPhase('request_config')
    currentTime = 18.4
    telemetry.markFirstToken()
    currentTime = 20
    telemetry.markFirstToken()
    telemetry.recordRetry({ layer: 'auto_retry', reason: 'network', attempt: 2 })
    telemetry.recordRetry({ layer: 'empty_response', reason: 'empty', attempt: 3 })
    telemetry.recordStep()
    telemetry.recordTool('search', 3.6)
    currentTime = 25.2

    expect(telemetry.buildPayload('success')).toEqual({
      trace_id: 'trace-1',
      engine: 'pi',
      model_id: 'model-1',
      model_name: 'claude',
      provider: 'anthropic',
      outcome: 'success',
      attempts: 3,
      retry_layers: ['auto_retry', 'empty_response'],
      retry_reasons: ['network', 'empty'],
      request_config_ms: 5,
      ttft_ms: 8,
      step_count: 1,
      tool_count: 1,
      tools: [{ name: 'search', duration_ms: 4 }],
      total_ms: 15,
    })
  })

  it('records error classes without content-like properties', () => {
    const telemetry = createTurnTelemetry({ now: () => 0, generateId: () => 'trace-1' })
    telemetry.recordError('rate-limit')

    const payload = telemetry.buildPayload('error')
    const keys = Object.keys(payload).join(' ').toLowerCase()

    expect(payload.error_class).toBe('rate-limit')
    expect(keys).not.toMatch(/prompt|text|message|apikey/)
    expect(Object.values(payload).every((value) => typeof value !== 'object' || Array.isArray(value))).toBe(true)
  })

  it('keeps turn model dimensions stable and omits recovered errors from success', () => {
    const telemetry = createTurnTelemetry({ now: () => 0, generateId: () => 'trace-1' })
    telemetry.setDimensions({ modelId: 'original', modelName: 'Original', provider: 'anthropic' })
    telemetry.recordError('network')
    telemetry.setDimensions({ modelId: 'replacement', modelName: 'Replacement', provider: 'openai' })

    expect(telemetry.buildPayload('success')).toMatchObject({
      model_id: 'original',
      model_name: 'Original',
      provider: 'anthropic',
    })
    expect(telemetry.buildPayload('success')).not.toHaveProperty('error_class')
  })
})
