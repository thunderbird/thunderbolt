/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LanguageModelUsage } from 'ai'
import {
  checkManagedInferenceAdmission,
  getInferenceQuotaLimits,
  recordInferenceUsage,
  type InferenceDatabase,
  type InferencePrice,
  type InferenceTokenCounts,
  type ManagedInferenceIdentity,
} from './usage-ledger'
import { createPriceUnavailableResponse, createQuotaExceededResponse } from './usage-responses'

type AdmitManagedRequestOptions = {
  database: InferenceDatabase
  settings: Parameters<typeof getInferenceQuotaLimits>[0]
  identity: ManagedInferenceIdentity
  user: { id: string; isAnonymous?: boolean | null }
  checkAdmission?: typeof checkManagedInferenceAdmission
}

/**
 * Gate a managed request on price and the user's rolling quota. A returned Response is the rejection to send:
 * 503 when the model has no price, 429 when a quota window is exhausted.
 */
export const admitManagedRequest = async ({
  database,
  settings,
  identity,
  user,
  checkAdmission = checkManagedInferenceAdmission,
}: AdmitManagedRequestOptions): Promise<{ price: InferencePrice } | Response> => {
  const admission = await checkAdmission(
    database,
    identity,
    user.id,
    getInferenceQuotaLimits(settings, user.isAnonymous === true),
  )
  if (admission.outcome === 'price-unavailable') {
    return createPriceUnavailableResponse()
  }
  if (admission.outcome === 'quota-exceeded') {
    return createQuotaExceededResponse(admission.decision)
  }
  return { price: admission.price }
}

/** Route telemetry around the ledger write. Hooks get metadata only, never request or response content. */
export type UsageTelemetry = {
  onRecording?: () => void
  onRecorded?: (outcome: Awaited<ReturnType<typeof recordInferenceUsage>>) => void
  onMissing: () => void
  onFailed: (error: unknown) => void
}

type UsageCallbacksOptions = {
  database: InferenceDatabase
  eventId: string
  userId: string
  /** The price admission returned, so the run is charged at the rate it was admitted at. */
  price: InferencePrice
  telemetry: UsageTelemetry
  recordUsage?: typeof recordInferenceUsage
}

/**
 * Callbacks that write a managed run's usage to the ledger, in the shape the SSE stream helpers take. For an
 * AI SDK run, drive them with {@link recordLanguageModelUsage}.
 */
export const createUsageCallbacks = ({
  database,
  eventId,
  userId,
  price,
  telemetry,
  recordUsage = recordInferenceUsage,
}: UsageCallbacksOptions) => ({
  onUsage: async (counts: InferenceTokenCounts) => {
    telemetry.onRecording?.()
    const outcome = await recordUsage(database, { id: eventId, userId, counts, price })
    telemetry.onRecorded?.(outcome)
  },
  onUsageMissing: telemetry.onMissing,
  onUsageError: telemetry.onFailed,
})

export type UsageCallbacks = ReturnType<typeof createUsageCallbacks>

/** Map AI SDK usage, summed across steps, onto the ledger's token counts; null when the provider sent none. */
export const toTokenCounts = (usage: LanguageModelUsage): InferenceTokenCounts | null => {
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

/**
 * Record an AI SDK run's usage through the callbacks, as the SSE helpers do for a raw stream: no usage skips
 * the ledger, and a failed write is reported rather than thrown, because the AI SDK swallows errors thrown
 * from `onFinish`.
 */
export const recordLanguageModelUsage = async (callbacks: UsageCallbacks, usage: LanguageModelUsage) => {
  const counts = toTokenCounts(usage)
  if (!counts) {
    callbacks.onUsageMissing()
    return
  }
  try {
    await callbacks.onUsage(counts)
  } catch (error) {
    callbacks.onUsageError(error)
  }
}
