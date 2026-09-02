/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { inferenceUsageReceiptPath, type InferenceUsageReceiptRequest } from '../../../shared/inference-usage.ts'
import type { AgentHarness } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { apiBaseUrl } from '../auth/config.ts'
import { abortable, settleBestEffort } from '../lib/abort.ts'
import type { AccountFetch } from './types.ts'

const receiptPostTimeoutMs = 3_000

export type SubmitInferenceUsageReceiptOptions = {
  readonly backendUrl: string
  readonly bearer: string
  readonly usage: InferenceUsageReceiptRequest
  readonly fetchFn?: AccountFetch
  readonly onUnauthorized?: () => Promise<void>
  readonly timeoutMs?: number
}

export type CompletedProviderStep = {
  readonly receipt: string
  readonly message: AssistantMessage
}

export type UsageReceiptLifecycle = {
  readonly completeProviderStep: (step: CompletedProviderStep) => void
  readonly clear: () => void
  readonly attach: (harness: Pick<AgentHarness, 'subscribe'>) => () => void
}

type UsageReceiptLifecycleOptions = {
  readonly submit: (usage: InferenceUsageReceiptRequest) => Promise<void>
}

/** Check that a provider token count is safe to serialize and persist. */
const isNonnegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

/** Map one terminal Pi message to the backend's receipt accounting contract. */
const toReceiptUsage = (step: CompletedProviderStep): InferenceUsageReceiptRequest | null => {
  const { input, cacheRead, cacheWrite, output, totalTokens } = step.message.usage
  const promptTokens = input + cacheRead + cacheWrite
  if (
    step.receipt.length === 0 ||
    !isNonnegativeSafeInteger(input) ||
    !isNonnegativeSafeInteger(cacheRead) ||
    !isNonnegativeSafeInteger(cacheWrite) ||
    !isNonnegativeSafeInteger(promptTokens) ||
    !isNonnegativeSafeInteger(output) ||
    !isNonnegativeSafeInteger(totalTokens)
  ) {
    return null
  }
  return {
    receipt: step.receipt,
    promptTokens,
    completionTokens: output,
    totalTokens,
  }
}

/** Correlate provider receipts with the exact terminal assistant event that owns their usage. */
export const createUsageReceiptLifecycle = (options: UsageReceiptLifecycleOptions): UsageReceiptLifecycle => {
  let pending: CompletedProviderStep | null = null
  const clear = (): void => {
    pending = null
  }
  const completeProviderStep = (step: CompletedProviderStep): void => {
    pending = step
  }
  const attach: UsageReceiptLifecycle['attach'] = (harness) => {
    const unsubscribeHarness = harness.subscribe(async (event) => {
      if (event.type === 'abort' || event.type === 'agent_end' || event.type === 'settled') {
        clear()
        return
      }
      if (event.type !== 'message_end' || pending === null) return

      const completed = pending
      if (event.message !== completed.message) return
      clear()
      if (completed.message.stopReason === 'error' || completed.message.stopReason === 'aborted') return

      const usage = toReceiptUsage(completed)
      if (usage === null) return
      await settleBestEffort(options.submit(usage))
    })
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      unsubscribeHarness()
      clear()
    }
  }
  return { completeProviderStep, clear, attach }
}

/** Submit one confidential-inference usage receipt with the stored session bearer. */
export const submitInferenceUsageReceipt = async (options: SubmitInferenceUsageReceiptOptions): Promise<void> => {
  const fetchFn = options.fetchFn ?? fetch
  const signal = AbortSignal.timeout(options.timeoutMs ?? receiptPostTimeoutMs)
  const request = async (): Promise<void> => {
    const response = await fetchFn(`${apiBaseUrl(options.backendUrl)}/${inferenceUsageReceiptPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.usage),
      redirect: 'error',
      signal,
    })
    if (response.status === 401 || response.status === 403) await options.onUnauthorized?.()
    if (!response.ok) {
      throw new Error(`Inference usage receipt request failed with HTTP ${response.status}`)
    }
  }
  await abortable(request(), signal)
}
