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
  releaseInferenceHold,
  releaseInferenceHolds,
  retainInferenceHold,
  type InferenceLedgerDatabase,
  type InferenceHold,
  type InferencePrice,
  type InferenceTokenCounts,
  type ManagedInferenceIdentity,
} from './usage-ledger'
import {
  createPriceUnavailableResponse,
  createQuotaExceededResponse,
  createRequestInProgressResponse,
} from './usage-responses'

/**
 * The holds this process admitted for requests that have not ended yet. Those requests die with the process, so
 * {@link releaseOpenHolds} releases their holds at shutdown.
 */
const openHolds = new Set<string>()

/** Release every hold this process still has open, so a shutdown charges nothing for the requests it cuts off. */
export const releaseOpenHolds = async (
  database: InferenceLedgerDatabase,
  releaseHolds: typeof releaseInferenceHolds = releaseInferenceHolds,
): Promise<void> => {
  const ids = [...openHolds]
  openHolds.clear()
  if (ids.length > 0) {
    await releaseHolds(database, ids)
  }
}

/** The resolved session user a managed request is admitted and charged for. */
export type ManagedRequestUser = { id: string; isAnonymous?: boolean | null }

type AdmitManagedRequestOptions = {
  database: InferenceLedgerDatabase
  settings: Parameters<typeof getInferenceQuotaLimits>[0]
  identity: ManagedInferenceIdentity
  user: ManagedRequestUser
  /** The route's `ctx.set`, given the rejection status too. The access log reads the status from the returned Response. */
  set: Pick<Context['set'], 'status'>
  /**
   * The most the request can cost. Its hold charges this, capped at what is left of the limit, until usage settles
   * it.
   */
  maxCostNanoUsd: InferenceHold['maxCostNanoUsd']
  logger?: InferenceLogger
  checkAdmission?: typeof checkManagedInferenceAdmission
  /**
   * The 429 for a request that does not fit beside the user's requests still running. A route may send its own code.
   */
  createInProgressResponse?: () => Response
}

/**
 * Gate a managed request on price and the user's rolling quota. An admitted request gets a hold for its maximum
 * cost, capped at what is left of the limit. The hold is recorded under a new usage event ID, and the request's usage
 * callbacks must use that ID to settle, release or retain it. A returned Response is the rejection to send: 503 when
 * the model has no price, which is a deployment fault and logged as an error, and 429 when a quota window is
 * exhausted or the request does not fit beside the user's requests still running.
 */
export const admitManagedRequest = async ({
  database,
  settings,
  identity,
  user,
  set,
  maxCostNanoUsd,
  logger,
  checkAdmission = checkManagedInferenceAdmission,
  createInProgressResponse = createRequestInProgressResponse,
}: AdmitManagedRequestOptions): Promise<{ price: InferencePrice; eventId: string } | Response> => {
  const eventId = crypto.randomUUID()
  const admission = await checkAdmission(
    database,
    identity,
    user.id,
    getInferenceQuotaLimits(settings, user.isAnonymous === true),
    { id: eventId, maxCostNanoUsd },
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
  if (admission.outcome === 'request-in-progress') {
    set.status = 429
    return createInProgressResponse()
  }
  openHolds.add(eventId)
  return { price: admission.price, eventId }
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
  database: InferenceLedgerDatabase
  eventId: string
  userId: string
  /** The price admission returned, so the run is charged at the rate it was admitted at. */
  price: InferencePrice
  telemetry: UsageTelemetry
  recordUsage?: typeof recordInferenceUsage
  releaseHold?: typeof releaseInferenceHold
  retainHold?: typeof retainInferenceHold
}

/** Waits before the second and third ledger write, so a brief database failure does not drop a finished run. */
const usageWriteRetryDelaysMs = [100, 500]

/**
 * Run a ledger write, retrying it after each delay. A retry is safe: usage settles a hold only once, and a release
 * or a retain touches only a hold that is not settled.
 */
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
 * AI SDK run, drive them with {@link recordLanguageModelUsage}. `release` deletes the hold, for a request that never
 * reached the provider or that the provider refused. `onEnd` runs once the request is over. It retains a hold that
 * neither usage nor `release` reached: the hold stays charged and stops counting as a request still running. A
 * failed release or retain is reported rather than thrown, like a failed usage write, and the hold stays charged.
 */
export const createUsageCallbacks = ({
  database,
  eventId,
  userId,
  price,
  telemetry,
  recordUsage = recordInferenceUsage,
  releaseHold = releaseInferenceHold,
  retainHold = retainInferenceHold,
}: UsageCallbacksOptions) => ({
  onUsage: async (counts: InferenceTokenCounts) => {
    invokeObserverSafely(telemetry.onUsageRecording)
    const outcome = await writeWithRetry(() => recordUsage(database, { id: eventId, userId, counts, price }))
    openHolds.delete(eventId)
    invokeObserverSafely(() => telemetry.onUsageRecorded?.(outcome))
  },
  onUsageMissing: () => invokeObserverSafely(telemetry.onUsageMissing),
  onUsageError: (error: unknown) => invokeObserverSafely(() => telemetry.onUsageError(error)),
  release: async () => {
    openHolds.delete(eventId)
    try {
      await writeWithRetry(() => releaseHold(database, eventId))
    } catch (error) {
      invokeObserverSafely(() => telemetry.onUsageError(error))
    }
  },
  onEnd: async () => {
    if (!openHolds.delete(eventId)) {
      return
    }
    try {
      await writeWithRetry(() => retainHold(database, eventId))
    } catch (error) {
      invokeObserverSafely(() => telemetry.onUsageError(error))
    }
  },
})

export type UsageCallbacks = ReturnType<typeof createUsageCallbacks>

/**
 * Characters per token for a usage estimate, outside the scripts in `denseScriptCharacter`. English text averages
 * about four, and the app's context meter uses 3.5 (`src/ai/tokenizers.ts`). Three makes the estimate err high on
 * purpose: it stands in for tokens the provider consumed but never reported, and an undercount would let a client
 * that aborts every run spend past its quota.
 */
const charsPerToken = 3

/**
 * Chinese, Japanese and Korean characters, which tokenize at roughly one token per one to one and a half
 * characters. Dividing them by `charsPerToken` would undercount them up to threefold, so each is one token.
 */
const denseScriptCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/** A conservative token count for `text`: one per CJK character, and one per three characters of the rest. */
export const estimateTokens = (text: string): number => {
  const denseCharacters = text.match(denseScriptCharacter)?.length ?? 0
  const otherCharacters = text.replace(denseScriptCharacter, '').length
  return denseCharacters + Math.ceil(otherCharacters / charsPerToken)
}

/**
 * Content the provider sizes by something other than its characters: an image, a document, or a file sent by ID.
 * An image is billed by its pixels, however few bytes encode it, and a document's pages can cost more than its
 * encoded bytes. In a body serialized from its parsed form, keys are never escaped and quotes inside strings always
 * are, so user text cannot create or hide a match.
 */
const unsizedContentPattern = /"type":"(?:image|image_url|document|file)"|"file_id":/

/** Whether a request body, serialized from its parsed value, carries content its own text does not bound. */
export const hasUnsizedContent = (serializedBody: string): boolean => unsizedContentPattern.test(serializedBody)

/** The most tokens `text` can take: one per UTF-8 byte, since no token is shorter than a byte. */
export const maxTextTokens = (text: string): number => Buffer.byteLength(text)

/**
 * The most prompt tokens a request can take: the model's whole context window when its body carries content its
 * text does not bound, otherwise {@link maxTextTokens} of the raw body. `serializedBody` is the parsed body
 * serialized again, which {@link hasUnsizedContent} needs.
 */
export const maxPromptTokens = (serializedBody: string, bodyText: string, contextWindow: number): number =>
  hasUnsizedContent(serializedBody) ? contextWindow : maxTextTokens(bodyText)

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
 * Record an AI SDK run's usage through the callbacks, as the SSE helpers do for a raw stream. A run without usage
 * is logged as missing and writes nothing, so its hold stays charged. A failed write is reported rather than thrown
 * (see {@link recordTokenCounts}).
 */
export const recordLanguageModelUsage = async (callbacks: UsageCallbacks, usage: LanguageModelUsage) => {
  const counts = toTokenCounts(usage)
  if (!counts) {
    callbacks.onUsageMissing()
    return
  }
  await recordTokenCounts(callbacks, counts)
}
