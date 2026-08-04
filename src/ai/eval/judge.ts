/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolveOpenAiCompatConnection } from '@/ai/fetch'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { defaultModelDeepseekV4Flash, defaultModelOpus48 } from '@shared/defaults/models'
import { generateText } from 'ai'
import { z } from 'zod'
import type { EvalCriteria, EvalResult, EvalScenario } from './types'

const judgeVerdictSchema = z
  .object({
    correct: z.boolean().nullable(),
    searchOffer: z.boolean().nullable(),
    premiseRebuttal: z.boolean().nullable(),
    verificationDisclaimer: z.boolean().nullable(),
    explanation: z.string(),
  })
  .strict()

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>
export type JudgeModelName = 'opus' | 'flash'

const judgeModels: Record<JudgeModelName, Model> = {
  opus: { ...defaultModelOpus48, apiKey: null },
  flash: { ...defaultModelDeepseekV4Flash, apiKey: null },
}

type VerdictKey = Exclude<keyof JudgeVerdict, 'explanation'>

const declaredAssertions = (criteria: EvalCriteria): Array<{ key: VerdictKey; label: string }> =>
  [
    criteria.expectCorrectAnswer ? { key: 'correct' as const, label: 'answer correctness' } : null,
    criteria.expectSearchOffer ? { key: 'searchOffer' as const, label: 'search offer' } : null,
    criteria.expectPremiseRebuttal ? { key: 'premiseRebuttal' as const, label: 'premise rebuttal' } : null,
    criteria.expectVerificationDisclaimer
      ? { key: 'verificationDisclaimer' as const, label: 'verification disclaimer' }
      : null,
  ].filter((assertion): assertion is { key: VerdictKey; label: string } => assertion !== null)

/** Select a capable judge that is neither GLM nor the model under evaluation. */
export const getJudgeModelName = (testedModelName: string): JudgeModelName => {
  if (testedModelName === 'opus') {
    return 'flash'
  }
  if (testedModelName === 'flash' || testedModelName === 'glm') {
    return 'opus'
  }
  throw new Error(`No judge assignment for eval model: ${testedModelName}`)
}

/** Whether a scenario declares at least one semantic assertion. */
export const requiresJudge = (criteria: EvalCriteria): boolean => declaredAssertions(criteria).length > 0

/** Parse the judge's strict JSON response, rejecting prose, missing fields, and extra fields. */
export const parseJudgeVerdict = (text: string): JudgeVerdict => {
  try {
    return judgeVerdictSchema.parse(JSON.parse(text))
  } catch (error) {
    throw new Error(`Invalid judge verdict: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Apply only the semantic assertions declared by the scenario's criteria. */
export const applyJudgeVerdict = (result: EvalResult, verdict: JudgeVerdict): EvalResult => {
  const judgeFailures = declaredAssertions(result.scenario.criteria).flatMap(({ key, label }) => {
    const value = verdict[key]
    if (value === null) {
      throw new Error(`Judge omitted declared assertion: ${key}`)
    }
    return value ? [] : [`Judge rejected ${label}: ${verdict.explanation}`]
  })
  const failures = [...result.failures, ...judgeFailures]
  return { ...result, passed: failures.length === 0, failures }
}

/** Run a declared judge check and surface judge failures as sample errors. */
export const evaluateWithJudge = async (
  result: EvalResult,
  evaluate: () => Promise<JudgeVerdict>,
): Promise<EvalResult> => {
  if (!requiresJudge(result.scenario.criteria)) {
    return result
  }
  try {
    return applyJudgeVerdict(result, await evaluate())
  } catch (error) {
    const message = `Judge error: ${error instanceof Error ? error.message : String(error)}`
    return {
      ...result,
      passed: false,
      failures: [...result.failures, message],
      error: message,
    }
  }
}

const buildJudgePrompt = (scenario: EvalScenario, responseText: string): string => {
  const assertions = declaredAssertions(scenario.criteria).map(({ key }) => key)
  return `Grade only these assertions: ${assertions.join(', ')}.
Be strict and factual. Unsupported claims make correctness fail. A search offer must include an actual answer first. A premise rebuttal must explicitly correct the false premise. A verification disclaimer must explicitly admit the answer cannot be verified.
Set unrequested assertion fields to null. Return only JSON with exactly: correct, searchOffer, premiseRebuttal, verificationDisclaimer, explanation.
User prompt: ${JSON.stringify(scenario.prompt)}
Assistant response: ${JSON.stringify(responseText)}`
}

/** Run one semantic judge call for a scenario sample. */
export const judgeScenario = async (
  scenario: EvalScenario,
  responseText: string,
  getProxyFetch: () => FetchFn,
): Promise<JudgeVerdict> => {
  const judgeName = getJudgeModelName(scenario.modelName)
  const judgeModel = judgeModels[judgeName]
  const connection = resolveOpenAiCompatConnection(judgeModel, getProxyFetch)
  if (!connection) {
    throw new Error(`Unable to resolve ${judgeName} judge connection`)
  }
  const provider = createOpenAICompatible({
    name: 'eval-judge',
    baseURL: connection.baseURL,
    apiKey: connection.apiKey,
    fetch: connection.fetch,
  })
  const { text } = await generateText({
    model: provider(judgeModel.model),
    prompt: buildJudgePrompt(scenario, responseText),
    temperature: 0,
    maxRetries: 0,
  })
  return parseJudgeVerdict(text)
}
