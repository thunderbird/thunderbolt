/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import type { Model } from '@/types'
import {
  inferenceUsageReceiptHeader,
  inferenceUsageReceiptPath,
  managedGlmIdentity,
  type InferenceUsageReceiptRequest,
} from '@shared/inference-usage'

type ReceiptModel = Pick<Model, 'provider' | 'model' | 'isSystem'>
// Receipt storage is a same-backend write; bound automatic step delay without coupling it to chat cancellation.
const receiptPostTimeoutMs = 3_000

export type ReceiptStep = Readonly<{
  response: { headers?: Record<string, string | undefined> }
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}>

/** Match the one frontend model allowed to redeem managed GLM usage receipts. */
export const isSystemGlmModel = (model: ReceiptModel): boolean =>
  model.provider === managedGlmIdentity.provider && model.model === managedGlmIdentity.model && model.isSystem === 1

/** Check whether an optional token count is a nonnegative JavaScript safe integer. */
const isNonnegativeSafeInteger = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value !== undefined && value >= 0

/** Validate and submit one completed managed GLM step's opaque usage receipt. */
export const submitGlmStepUsageReceipt = async ({
  model,
  step,
  httpClient,
}: {
  model: ReceiptModel
  step: ReceiptStep
  httpClient: Pick<HttpClient, 'post'>
}): Promise<void> => {
  if (!isSystemGlmModel(model)) {
    return
  }

  const receipt = step.response.headers?.[inferenceUsageReceiptHeader.toLowerCase()]
  const { inputTokens, outputTokens, totalTokens } = step.usage
  if (
    !receipt ||
    !isNonnegativeSafeInteger(inputTokens) ||
    !isNonnegativeSafeInteger(outputTokens) ||
    !isNonnegativeSafeInteger(totalTokens)
  ) {
    return
  }

  const body: InferenceUsageReceiptRequest = {
    receipt,
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
  }
  await httpClient.post(inferenceUsageReceiptPath, { json: body, timeout: receiptPostTimeoutMs })
}
