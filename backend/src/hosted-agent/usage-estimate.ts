/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toTokenCounts } from '@/inference/managed-request'
import type { InferenceTokenCounts } from '@/inference/usage-ledger'
import type { LanguageModelUsage, ModelMessage } from 'ai'

/**
 * Characters per token for a usage estimate. English text averages about four, and the app's context meter uses
 * 3.5 (`src/ai/tokenizers.ts`). Three makes the estimate err high on purpose: it stands in for tokens the provider
 * consumed but never reported, and an undercount would let a client that aborts every run spend past its quota.
 */
const charsPerToken = 3

/** A conservative token count for `text`: see `charsPerToken`. */
const estimateTokens = (text: string): number => Math.ceil(text.length / charsPerToken)

type RunUsageEstimateInput = {
  system: string
  messages: ModelMessage[]
  /** Text and reasoning the provider streamed before the run ended. */
  outputText: string
}

/**
 * Ledger counts for a run that ended before the provider reported usage. The prompt is the system prompt plus
 * the messages serialized as JSON, whose quoting and punctuation push the count higher still. Cache tokens are
 * zero, so a prompt the provider served from cache is charged at the uncached rate.
 */
const estimateRunUsage = ({ system, messages, outputText }: RunUsageEstimateInput): InferenceTokenCounts => {
  const promptTokens = estimateTokens(system) + estimateTokens(JSON.stringify(messages))
  const completionTokens = estimateTokens(outputText)
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  }
}

/**
 * Counts to bill an aborted run. An abort that lands after the run's last step still reaches onFinish, and if
 * the provider's usage arrived by then it wins, so the run is billed once at its real usage. Otherwise the run
 * is estimated: the provider consumed the tokens either way.
 */
export const getAbortedRunCounts = ({
  reportedUsage,
  ...estimateInput
}: RunUsageEstimateInput & { reportedUsage?: LanguageModelUsage }): {
  counts: InferenceTokenCounts
  estimated: boolean
} => {
  const reported = reportedUsage && toTokenCounts(reportedUsage)
  return reported
    ? { counts: reported, estimated: false }
    : { counts: estimateRunUsage(estimateInput), estimated: true }
}
