/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { inferenceUsageReceiptPath, type InferenceUsageReceiptRequest } from '../../../shared/inference-usage.ts'
import { toError, type AgentHarness } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { apiBaseUrl, backendHeaders } from '../auth/config.ts'
import { abortable, createSerialQueue } from '../lib/abort.ts'
import { isRecord } from '../lib/json.ts'
import { readFileOrNull, removeSecureFile, withSecureFileLock, writeSecureFile } from '../lib/secure-fs.ts'
import type { AccountFetch } from './types.ts'

const receiptPostTimeoutMs = 3_000
const receiptRetryDelaysMs = [100, 500] as const
type ReceiptFailureDisposition = 'retry' | 'retain' | 'discard'

class ReceiptHttpError extends Error {
  constructor(message: string, readonly disposition: ReceiptFailureDisposition) {
    super(message)
  }
}

export type SubmitInferenceUsageReceiptOptions = {
  readonly backendUrl: string
  readonly bearer: string
  readonly usage: InferenceUsageReceiptRequest
  readonly fetchFn?: AccountFetch
  readonly onUnauthorized?: () => Promise<void>
  readonly reportError?: (error: Error) => void
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
  readonly outboxPath: string
  readonly reportError?: (error: Error) => void
  readonly wait?: (milliseconds: number) => Promise<void>
}

/** Check that a provider token count is safe to serialize and persist. */
const isNonnegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

/** Validate one persisted receipt before submitting local outbox state. */
const isReceiptUsage = (value: unknown): value is InferenceUsageReceiptRequest =>
  isRecord(value) &&
  typeof value.receipt === 'string' &&
  value.receipt.length > 0 &&
  typeof value.promptTokens === 'number' &&
  isNonnegativeSafeInteger(value.promptTokens) &&
  typeof value.completionTokens === 'number' &&
  isNonnegativeSafeInteger(value.completionTokens) &&
  typeof value.totalTokens === 'number' &&
  isNonnegativeSafeInteger(value.totalTokens)

/** Read and validate the small durable queue of unacknowledged receipts. */
const readOutbox = async (path: string): Promise<InferenceUsageReceiptRequest[]> => {
  const contents = await readFileOrNull(path)
  if (contents === null) return []
  const parsed: unknown = JSON.parse(contents)
  if (!Array.isArray(parsed) || !parsed.every(isReceiptUsage)) {
    throw new Error(`Inference usage receipt outbox is invalid: ${path}`)
  }
  return parsed
}

/** Atomically replace the durable queue, removing its file once empty. */
const writeOutbox = async (path: string, entries: readonly InferenceUsageReceiptRequest[]): Promise<void> => {
  if (entries.length === 0) {
    await removeSecureFile(path)
    return
  }
  await writeSecureFile(path, `${JSON.stringify(entries)}\n`)
}

/** Attempt one submission three times and return whether its outbox entry can be removed. */
const submitWithRetry = async (
  submit: UsageReceiptLifecycleOptions['submit'],
  usage: InferenceUsageReceiptRequest,
  wait: NonNullable<UsageReceiptLifecycleOptions['wait']>,
  attempt = 0,
): Promise<boolean> => {
  try {
    await submit(usage)
    return true
  } catch (error) {
    if (error instanceof ReceiptHttpError && error.disposition !== 'retry') {
      return error.disposition === 'discard'
    }
    const delay = receiptRetryDelaysMs[attempt]
    if (delay === undefined) return false
    await wait(delay)
    return submitWithRetry(submit, usage, wait, attempt + 1)
  }
}

/** Submit every queued receipt and retain only entries that remain unacknowledged. */
const flushOutbox = async (
  path: string,
  entries: readonly InferenceUsageReceiptRequest[],
  submit: UsageReceiptLifecycleOptions['submit'],
  wait: NonNullable<UsageReceiptLifecycleOptions['wait']>,
): Promise<void> => {
  const remaining: InferenceUsageReceiptRequest[] = []
  for (const usage of entries) {
    if (!(await submitWithRetry(submit, usage, wait))) remaining.push(usage)
  }
  if (entries.length > 0 && remaining.length === entries.length) return
  await writeOutbox(path, remaining)
}

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
export const createUsageReceiptLifecycle = async (
  options: UsageReceiptLifecycleOptions,
): Promise<UsageReceiptLifecycle> => {
  const outboxPath = options.outboxPath
  const reportError = options.reportError ?? ((error: Error) => console.error('Usage receipt persistence failed.', error))
  const wait = options.wait ?? Bun.sleep
  const queue = createSerialQueue()
  await withSecureFileLock(outboxPath, async () =>
    flushOutbox(outboxPath, await readOutbox(outboxPath), options.submit, wait),
  )
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
      try {
        await queue.run(() =>
          withSecureFileLock(outboxPath, async () => {
            const entries = [...(await readOutbox(outboxPath)), usage]
            await writeOutbox(outboxPath, entries)
            await flushOutbox(outboxPath, entries, options.submit, wait)
          }),
        )
      } catch (error) {
        reportError(toError(error))
      }
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
  const reportError = options.reportError ?? ((error: Error) => console.error('Usage receipt auth observer failed.', error))
  const signal = AbortSignal.timeout(options.timeoutMs ?? receiptPostTimeoutMs)
  // Bun may release an AbortSignal.timeout timer when sequential races briefly have no listener.
  const retainDeadline = (): void => {}
  signal.addEventListener('abort', retainDeadline, { once: true })
  try {
    const response = await abortable(
      fetchFn(`${apiBaseUrl(options.backendUrl)}/${inferenceUsageReceiptPath}`, {
        method: 'POST',
        headers: backendHeaders({
          Authorization: `Bearer ${options.bearer}`,
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(options.usage),
        redirect: 'error',
        signal,
      }),
      signal,
    )
    if (response.status === 401) {
      const failure = new ReceiptHttpError('Inference usage receipt request failed with HTTP 401', 'retain')
      if (options.onUnauthorized) {
        try {
          await abortable(options.onUnauthorized(), signal)
        } catch (error) {
          reportError(toError(error))
        }
      }
      throw failure
    }
    if (response.status === 403) {
      // The backend reserves 403 for a receipt owned by another user; retrying it can never succeed for this account.
      throw new ReceiptHttpError('Inference usage receipt request failed with HTTP 403', 'discard')
    }
    if (!response.ok) {
      throw new ReceiptHttpError(
        `Inference usage receipt request failed with HTTP ${response.status}`,
        response.status === 429 || response.status >= 500 ? 'retry' : 'retain',
      )
    }
  } finally {
    signal.removeEventListener('abort', retainDeadline)
  }
}
