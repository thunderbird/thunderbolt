/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * OpenTelemetry GenAI span attribute names, from open-telemetry/semantic-conventions-genai
 * at commit e57c543b (all attributes are status Development there), plus the PostHog
 * passthroughs and one Thunderbolt attribute we export.
 *
 * Content attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`,
 * `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`) are deliberately
 * absent: we never emit prompts, responses, or tool payloads.
 *
 * Cache writes appear twice: `cache_write` is the current spec name, while PostHog's OTLP mapper
 * still reads the older `cache_creation`.
 */
export const genAiAttributes = {
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  requestStream: 'gen_ai.request.stream',
  responseModel: 'gen_ai.response.model',
  responseFinishReasons: 'gen_ai.response.finish_reasons',
  responseTimeToFirstChunk: 'gen_ai.response.time_to_first_chunk',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  usageCacheReadInputTokens: 'gen_ai.usage.cache_read.input_tokens',
  usageCacheWriteInputTokens: 'gen_ai.usage.cache_write.input_tokens',
  usageCacheCreationInputTokens: 'gen_ai.usage.cache_creation.input_tokens',
  usageReasoningOutputTokens: 'gen_ai.usage.reasoning.output_tokens',
  errorType: 'error.type',
  serverAddress: 'server.address',
  posthogDistinctId: 'posthog.distinct_id',
  posthogCacheReportingExclusive: '$ai_cache_reporting_exclusive',
  posthogTotalCostUsd: '$ai_total_cost_usd',
  thunderboltEndpoint: 'thunderbolt.endpoint',
} as const

export const genAiOperationChat = 'chat'

/** Every span attribute we may export to PostHog; anything else is stripped before export. */
export const genAiAttributeAllowlist: ReadonlySet<string> = new Set(Object.values(genAiAttributes))
