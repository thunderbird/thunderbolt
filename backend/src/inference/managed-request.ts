/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invokeObserverSafely } from '@/utils/streaming'
import type { LanguageModelUsage } from 'ai'
import type { Context } from 'elysia'
import { logInferenceSafely, type InferenceLogger, type InferenceProvider } from './client'
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

/** The resolved session user a managed request is admitted and charged for. */
export type ManagedRequestUser = { id: string; isAnonymous?: boolean | null }

type AdmitManagedRequestOptions = {
  database: InferenceDatabase
  settings: Parameters<typeof getInferenceQuotaLimits>[0]
  identity: ManagedInferenceIdentity
  user: ManagedRequestUser
  /** The route's `ctx.set`, given the rejection status too. The access log reads the status from the returned Response. */
  set: Pick<Context['set'], 'status'>
  logger?: InferenceLogger
  checkAdmission?: typeof checkManagedInferenceAdmission
}

/**
 * Gate a managed request on price and the user's rolling quota. A returned Response is the rejection to send:
 * 503 when the model has no price, which is a deployment fault and logged as an error, and 429 when a quota
 * window is exhausted.
 */
export const admitManagedRequest = async ({
  database,
  settings,
  identity,
  user,
  set,
  logger,
  checkAdmission = checkManagedInferenceAdmission,
}: AdmitManagedRequestOptions): Promise<{ price: InferencePrice } | Response> => {
  const admission = await checkAdmission(
    database,
    identity,
    user.id,
    getInferenceQuotaLimits(settings, user.isAnonymous === true),
  )
  if (admission.outcome === 'price-unavailable') {
    logger?.error?.({ event: 'inference_price_unavailable', ...identity }, 'Inference price unavailable')
    set.status = 503
    return createPriceUnavailableResponse()
  }
  if (admission.outcome === 'quota-exceeded') {
    set.status = 429
    return createQuotaExceededResponse(admission.decision)
  }
  return { price: admission.price }
}

/**
 * Route telemetry around the ledger write, named like the callbacks it backs. Hooks get metadata only, never
 * request or response content, and run through `invokeObserverSafely`, so a throwing hook cannot skip the write.
 */
export type UsageTelemetry = {
  onUsageRecording?: () => void
  onUsageRecorded?: (outcome: Awaited<ReturnType<typeof recordInferenceUsage>>) => void
  onUsageMissing: () => void
  onUsageError: (error: unknown) => void
}

type UsageTelemetryOptions = {
  eventId: string
  logger?: InferenceLogger
  model: string
  provider: InferenceProvider
  route: string
  /** How the request reached the provider: `direct` for the `/v1/chat` routes, `tinfoil` for the enclave proxy. */
  transport: 'direct' | 'tinfoil'
}

/** The usage log events around the shared ledger write. */
export const createUsageTelemetry = ({
  eventId,
  logger,
  model,
  provider,
  route,
  transport,
}: UsageTelemetryOptions): UsageTelemetry => ({
  onUsageRecording: () => {
    logInferenceSafely(
      logger,
      { event: 'inference_usage_completed', provider, model, eventId, transport },
      'Inference usage completed',
    )
  },
  onUsageRecorded: (outcome) => {
    logInferenceSafely(
      logger,
      { event: 'inference_usage_inserted', provider, model, eventId, outcome },
      'Inference usage inserted',
    )
  },
  onUsageMissing: () => {
    logger?.info({ event: 'inference_usage_missing', provider, model, route }, 'Inference usage missing')
  },
  onUsageError: () => {
    logger?.info(
      { event: 'inference_usage_callback_failed', provider, model, route },
      'Inference usage callback failed',
    )
  },
})

type UsageCallbacksOptions = {
  database: InferenceDatabase
  eventId: string
  userId: string
  /** The price admission returned, so the run is charged at the rate it was admitted at. */
  price: InferencePrice
  telemetry: UsageTelemetry
  recordUsage?: typeof recordInferenceUsage
}

/** Waits before the second and third ledger write, so a brief database failure does not drop a finished run. */
const usageWriteRetryDelaysMs = [100, 500]

/** Run a ledger write, retrying it after each delay. A retry is safe: the insert ignores an event ID it already has. */
const writeWithRetry = async <T>(write: () => Promise<T>, attempt = 0): Promise<T> => {
  try {
    return await write()
  } catch (error) {
    const delayMs = usageWriteRetryDelaysMs[attempt]
    if (delayMs === undefined) {
      throw error
    }
    await Bun.sleep(delayMs)
    return writeWithRetry(write, attempt + 1)
  }
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
    invokeObserverSafely(telemetry.onUsageRecording)
    const outcome = await writeWithRetry(() => recordUsage(database, { id: eventId, userId, counts, price }))
    invokeObserverSafely(() => telemetry.onUsageRecorded?.(outcome))
  },
  onUsageMissing: () => invokeObserverSafely(telemetry.onUsageMissing),
  onUsageError: (error: unknown) => invokeObserverSafely(() => telemetry.onUsageError(error)),
})

type UsageCallbacks = ReturnType<typeof createUsageCallbacks>

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
 * Write token counts through the callbacks. A failed write is reported rather than thrown: an AI SDK run
 * records from a callback or a detached promise, where a throw is swallowed or goes unhandled.
 */
export const recordTokenCounts = async (callbacks: UsageCallbacks, counts: InferenceTokenCounts) => {
  try {
    await callbacks.onUsage(counts)
  } catch (error) {
    callbacks.onUsageError(error)
  }
}

/**
 * Record an AI SDK run's usage through the callbacks, as the SSE helpers do for a raw stream: no usage skips
 * the ledger, and a failed write is reported rather than thrown (see {@link recordTokenCounts}).
 */
export const recordLanguageModelUsage = async (callbacks: UsageCallbacks, usage: LanguageModelUsage) => {
  const counts = toTokenCounts(usage)
  if (!counts) {
    callbacks.onUsageMissing()
    return
  }
  await recordTokenCounts(callbacks, counts)
}
