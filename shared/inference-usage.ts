/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const inferenceModelHeader = 'X-Inference-Model'
export const inferenceUsageReceiptHeader = 'X-Inference-Usage-Receipt'
export const inferenceUsageReceiptPath = 'inference-usage/receipts'

export type InferenceUsageReceiptRequest = {
  receipt: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
}
