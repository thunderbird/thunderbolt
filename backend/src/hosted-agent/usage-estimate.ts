/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toTokenCounts } from '@/inference/managed-request'
import type { InferenceTokenCounts } from '@/inference/usage-ledger'
import type { LanguageModelUsage, ModelMessage } from 'ai'

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
const estimateTokens = (text: string): number => {
  const denseCharacters = text.match(denseScriptCharacter)?.length ?? 0
  const otherCharacters = text.replace(denseScriptCharacter, '').length
  return denseCharacters + Math.ceil(otherCharacters / charsPerToken)
}

type StepUsageEstimateInput = {
  system: string
  /** The tools' definitions as JSON, which a step that offers tools is billed for too. */
  toolDefinitions?: string
  /** What the step in flight was sent: the conversation, then the tool calls and results of the steps before it. */
  messages: ModelMessage[]
  /** Text, reasoning and tool-call input the step in flight streamed before the run ended. */
  outputText: string
}

/**
 * Ledger counts for a step that ended before the provider reported usage. The prompt is the system prompt, the
 * tool definitions and the messages serialized as JSON, whose quoting and punctuation push the count higher still.
 * Cache tokens are zero, so a prompt the provider served from cache is charged at the uncached rate.
 */
const estimateStepUsage = ({
  system,
  toolDefinitions = '',
  messages,
  outputText,
}: StepUsageEstimateInput): InferenceTokenCounts => {
  const promptTokens =
    estimateTokens(system) + estimateTokens(toolDefinitions) + estimateTokens(JSON.stringify(messages))
  const completionTokens = estimateTokens(outputText)
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  }
}

/** Field-by-field sum of the counts of a run's steps. */
const sumCounts = (steps: InferenceTokenCounts[]): InferenceTokenCounts => {
  const total = (field: keyof InferenceTokenCounts) => steps.reduce((sum, counts) => sum + (counts[field] ?? 0), 0)
  return {
    promptTokens: total('promptTokens'),
    completionTokens: total('completionTokens'),
    totalTokens: total('totalTokens'),
    cacheCreationTokens: total('cacheCreationTokens'),
    cacheCreation1hTokens: total('cacheCreation1hTokens'),
    cacheReadTokens: total('cacheReadTokens'),
  }
}

/** The counts of the steps that reported usage. A step without it is left out, as a run without it would be. */
const reportedStepCounts = (steps: LanguageModelUsage[]) => steps.map(toTokenCounts).filter((counts) => counts !== null)

/**
 * Counts to bill a run that ended without an abort. A run that finished reports its total. One whose later step
 * failed upstream (a 529 after retries, or a context overflow once tool results grew the prompt) reports none, so
 * it is billed at what its finished steps reported: the provider charged for those either way. Null when no step
 * reported usage.
 */
export const getSettledRunCounts = (
  totalUsage: LanguageModelUsage,
  steps: LanguageModelUsage[],
): InferenceTokenCounts | null => {
  const reported = toTokenCounts(totalUsage)
  if (reported) {
    return reported
  }
  const finished = reportedStepCounts(steps)
  return finished.length > 0 ? sumCounts(finished) : null
}

/**
 * Counts to bill an aborted run. When the abort lands after the run's last step the provider's total has arrived,
 * and it wins, so the run is billed once at its real usage. Otherwise the run is billed at what its finished steps
 * reported, plus an estimate for the step in flight: the provider consumed those tokens either way. A step stays in
 * flight until its tool calls settle, so an abort while a tool runs estimates the step that called it.
 */
export const getAbortedRunCounts = ({
  reportedUsage,
  finishedSteps = [],
  ...estimateInput
}: StepUsageEstimateInput & { reportedUsage?: LanguageModelUsage; finishedSteps?: LanguageModelUsage[] }): {
  counts: InferenceTokenCounts
  estimated: boolean
} => {
  const reported = reportedUsage && toTokenCounts(reportedUsage)
  if (reported) {
    return { counts: reported, estimated: false }
  }
  return {
    counts: sumCounts([...reportedStepCounts(finishedSteps), estimateStepUsage(estimateInput)]),
    estimated: true,
  }
}
