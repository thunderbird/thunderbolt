/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolveOpenAiCompatConnection } from '@/ai/fetch'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { defaultModelDeepseekV4Flash, defaultModelOpus5 } from '@shared/defaults/models'
import { streamText, type LanguageModel } from 'ai'
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

class RetryableJudgeError extends Error {}

const judgeModels: Record<JudgeModelName, Model> = {
  opus: { ...defaultModelOpus5, apiKey: null },
  flash: { ...defaultModelDeepseekV4Flash, apiKey: null },
}

type SemanticAssertion = {
  criteriaKey: 'expectCorrectAnswer' | 'expectSearchOffer' | 'expectPremiseRebuttal' | 'expectVerificationDisclaimer'
  verdictKey: Exclude<keyof JudgeVerdict, 'explanation'>
  label: string
  guidance: string
}

const semanticAssertions: SemanticAssertion[] = [
  {
    criteriaKey: 'expectCorrectAnswer',
    verdictKey: 'correct',
    label: 'answer correctness',
    guidance:
      'correct: Judge factual or functional correctness strictly against your own knowledge of the timeless fact or task. Unsupported claims fail only the correct assertion. Sources and citations are not required.',
  },
  {
    criteriaKey: 'expectSearchOffer',
    verdictKey: 'searchOffer',
    label: 'search offer',
    guidance: 'searchOffer: Judge only whether the response actually answered first, then offered to search or verify.',
  },
  {
    criteriaKey: 'expectPremiseRebuttal',
    verdictKey: 'premiseRebuttal',
    label: 'premise rebuttal',
    guidance: 'premiseRebuttal: Judge only whether the response explicitly corrected the false premise.',
  },
  {
    criteriaKey: 'expectVerificationDisclaimer',
    verdictKey: 'verificationDisclaimer',
    label: 'verification disclaimer',
    guidance:
      'verificationDisclaimer: Judge only whether the response explicitly admitted it could not verify the answer.',
  },
]

const declaredAssertions = (criteria: EvalCriteria): SemanticAssertion[] =>
  semanticAssertions.filter(({ criteriaKey }) => criteria[criteriaKey])

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

/** Extract the judge's outermost JSON object while leaving schema validation strict. */
const extractJudgeJson = (text: string): string => {
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  return firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : text.trim()
}

/** Parse the judge's JSON response, tolerating formatting noise but rejecting schema drift. */
export const parseJudgeVerdict = (text: string): JudgeVerdict => {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJudgeJson(text))
  } catch (error) {
    throw new RetryableJudgeError(`Invalid judge verdict: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  try {
    return judgeVerdictSchema.parse(parsed)
  } catch (error) {
    throw new Error(`Invalid judge verdict: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

/** Apply only the semantic assertions declared by the scenario's criteria. */
export const applyJudgeVerdict = (result: EvalResult, verdict: JudgeVerdict): EvalResult => {
  const judgeFailures = declaredAssertions(result.scenario.criteria).flatMap(({ verdictKey, label }) => {
    const value = verdict[verdictKey]
    if (value === null) {
      throw new RetryableJudgeError(`Judge omitted declared assertion: ${verdictKey}`)
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
    const evaluateOnce = async (): Promise<EvalResult> => applyJudgeVerdict(result, await evaluate())
    try {
      return await evaluateOnce()
    } catch (error) {
      if (!(error instanceof RetryableJudgeError)) {
        throw error
      }
      return await evaluateOnce()
    }
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

/** Build the terse semantic grading prompt for a scenario's scored turn. */
export const buildJudgePrompt = (scenario: EvalScenario, responseText: string): string => {
  const assertions = declaredAssertions(scenario.criteria)
  const userPrompt = scenario.followUps?.at(-1) ?? scenario.prompt
  return `Grade only these assertions: ${assertions.map(({ verdictKey }) => verdictKey).join(', ')}.
${assertions.map(({ guidance }) => guidance).join('\n')}
Every DECLARED assertion MUST be true or false; never return null for a declared assertion. ONLY UNDECLARED assertion fields may be null, and every undeclared assertion field MUST be null.
Return only JSON with exactly: correct, searchOffer, premiseRebuttal, verificationDisclaimer, explanation.
User prompt: ${JSON.stringify(userPrompt)}
Assistant response: ${JSON.stringify(responseText)}`
}

/** Request a judge verdict through the streaming transport required by the app backend. */
export const requestJudgeVerdict = async (model: LanguageModel, prompt: string): Promise<JudgeVerdict> => {
  const result = streamText({
    model,
    prompt,
    temperature: 0,
    maxRetries: 0,
  })
  return parseJudgeVerdict(await result.text)
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
  return requestJudgeVerdict(provider(judgeModel.model), buildJudgePrompt(scenario, responseText))
}
