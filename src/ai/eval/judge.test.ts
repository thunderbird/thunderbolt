/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { resolveOpenAiCompatConnection } from '@/ai/fetch'
import type { FetchFn } from '@/lib/proxy-fetch'
import {
  applyJudgeVerdict,
  buildJudgePrompt,
  evaluateWithJudge,
  getJudgeModelName,
  judgeModels,
  parseJudgeVerdict,
  requestJudgeVerdict,
  requiresJudge,
} from './judge'
import { evalModels } from './scenarios'
import type { EvalResult, EvalScenario } from './types'

const scenario: EvalScenario = {
  id: 'opus/pi/chat/never-search-01',
  modelName: 'opus',
  engineName: 'pi',
  modeName: 'chat',
  prompt: 'When did the Berlin Wall fall?',
  criteria: { mustProduceOutput: true, expectCorrectAnswer: true },
}

const result: EvalResult = {
  scenario,
  passed: true,
  failures: [],
  responseText: '1989.',
  responseLength: 5,
  citations: [],
  widgets: [],
  linkPreviewUrls: [],
  homepageUrls: [],
  reviewSiteUrls: [],
  toolCallCount: 0,
  duplicateToolCallCount: 0,
  retryCount: 0,
  durationMs: 1,
}

const acceptedVerdict = {
  correct: true,
  searchOffer: null,
  premiseRebuttal: null,
  verificationDisclaimer: null,
  replyLanguageMatches: null,
  explanation: 'The year is correct.',
}

describe('judge model assignment', () => {
  test('assigns every eval model to Opus, including Opus itself', () => {
    for (const testedModel of evalModels) {
      expect(getJudgeModelName(testedModel.name)).toBe('opus')
    }
  })

  test('only uses non-confidential judge models', () => {
    for (const judgeModel of Object.values(judgeModels)) {
      expect(judgeModel.provider).not.toBe('tinfoil')
      expect(judgeModel.isConfidential).toBe(0)
    }
  })

  test('resolves an OpenAI-compatible connection for every judge model', () => {
    const proxyFetch: FetchFn = Object.assign(
      async () => {
        throw new Error('Connection resolution must not make network requests')
      },
      { preconnect: () => Promise.resolve(false) },
    )

    for (const judgeModel of Object.values(judgeModels)) {
      expect(resolveOpenAiCompatConnection(judgeModel, () => proxyFetch)).not.toBeNull()
    }
  })

  test('fails loudly with assignment map guidance for an unknown eval model', () => {
    expect(() => getJudgeModelName('new-model')).toThrow(
      'No judge assignment for eval model: new-model. Update judgeModelAssignments in src/ai/eval/judge.ts.',
    )
  })
})

describe('judge verdict parsing', () => {
  test('parses a strict JSON verdict', () => {
    expect(parseJudgeVerdict(JSON.stringify(acceptedVerdict))).toMatchObject({ correct: true })
  })

  test('parses JSON wrapped in a markdown fence', () => {
    expect(parseJudgeVerdict(`\`\`\`json\n${JSON.stringify(acceptedVerdict)}\n\`\`\``)).toEqual(acceptedVerdict)
  })

  test('parses fenced JSON with another language tag and surrounding prose', () => {
    const response = `Here is the requested verdict:
\`\`\`javascript
${JSON.stringify(acceptedVerdict)}
\`\`\`
This is the final result.`

    expect(parseJudgeVerdict(response)).toEqual(acceptedVerdict)
  })

  test('rejects malformed JSON instead of treating it as a pass', () => {
    expect(() => parseJudgeVerdict('The answer looks correct.')).toThrow('Invalid judge verdict')
  })

  test('rejects extra fields', () => {
    expect(() =>
      parseJudgeVerdict(
        JSON.stringify({
          correct: true,
          searchOffer: null,
          premiseRebuttal: null,
          verificationDisclaimer: null,
          replyLanguageMatches: null,
          explanation: 'ok',
          pass: true,
        }),
      ),
    ).toThrow('Invalid judge verdict')
  })

  test('requests and aggregates a streaming OpenAI-compatible verdict', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const judgeFetch: typeof fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        const chunks = [
          {
            id: 'judge',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'judge',
            choices: [
              { index: 0, delta: { role: 'assistant', content: JSON.stringify(acceptedVerdict) }, finish_reason: null },
            ],
          },
          {
            id: 'judge',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'judge',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ]
        return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
      { preconnect: fetch.preconnect },
    )
    const provider = createOpenAICompatible({
      name: 'judge-test',
      baseURL: 'https://judge.invalid/v1',
      apiKey: 'test',
      fetch: judgeFetch,
    })

    await expect(requestJudgeVerdict(provider('judge'), 'Grade this.')).resolves.toEqual(acceptedVerdict)
    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0].stream).toBe(true)
  })
})

describe('judge-backed criteria', () => {
  test('only invokes the judge for declared assertions', () => {
    expect(requiresJudge(scenario.criteria)).toBe(true)
    expect(requiresJudge({ mustProduceOutput: true })).toBe(false)
  })

  test('fails a declared assertion when the judge rejects it', () => {
    const judged = applyJudgeVerdict(result, {
      correct: false,
      searchOffer: null,
      premiseRebuttal: null,
      verificationDisclaimer: null,
      replyLanguageMatches: null,
      explanation: 'The response gave the wrong year.',
    })

    expect(judged.passed).toBe(false)
    expect(judged.failures).toContain('Judge rejected answer correctness: The response gave the wrong year.')
  })

  test('requires a non-null verdict for every declared assertion', () => {
    expect(() =>
      applyJudgeVerdict(result, {
        correct: null,
        searchOffer: null,
        premiseRebuttal: null,
        verificationDisclaimer: null,
        replyLanguageMatches: null,
        explanation: 'No verdict.',
      }),
    ).toThrow('Judge omitted declared assertion: correct')
  })

  test('marks judge failures as sample errors instead of passing', async () => {
    let attempts = 0
    const judged = await evaluateWithJudge(result, async () => {
      attempts++
      throw new Error('upstream unavailable')
    })

    expect(attempts).toBe(1)
    expect(judged.passed).toBe(false)
    expect(judged.error).toBe('Judge error: upstream unavailable')
    expect(judged.failures).toContain('Judge error: upstream unavailable')
  })

  test('aborts a hanging judge attempt when its timeout expires', async () => {
    let triggerTimeout: (() => void) | undefined
    let aborted = false
    const judgedPromise = evaluateWithJudge(
      result,
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason)
            },
            { once: true },
          )
        }),
      {
        attemptTimeoutMs: 60_000,
        scheduleTimeout: (callback) => {
          triggerTimeout = callback
          return () => {
            triggerTimeout = undefined
          }
        },
      },
    )
    await Promise.resolve()

    expect(triggerTimeout).toBeDefined()
    triggerTimeout?.()
    const judged = await judgedPromise

    expect(aborted).toBe(true)
    expect(judged.passed).toBe(false)
    expect(judged.error).toBe('Judge error: Judge timed out')
  })

  test('retries an omitted declared assertion once before reporting the error', async () => {
    let attempts = 0
    const judged = await evaluateWithJudge(result, async () => {
      attempts++
      return { ...acceptedVerdict, correct: null }
    })

    expect(attempts).toBe(2)
    expect(judged.error).toBe('Judge error: Judge omitted declared assertion: correct')
  })

  test('caps a retry to the remaining overall judge deadline', async () => {
    const scheduledDelays: number[] = []
    const nowValues = [0, 0, 90_000]
    let attempts = 0
    const judged = await evaluateWithJudge(
      result,
      async () => {
        attempts++
        return attempts === 1 ? { ...acceptedVerdict, correct: null } : acceptedVerdict
      },
      {
        attemptTimeoutMs: 60_000,
        now: () => nowValues.shift() ?? 90_000,
        scheduleTimeout: (_callback, delayMs) => {
          scheduledDelays.push(delayMs)
          return () => {}
        },
      },
    )

    expect(judged.passed).toBe(true)
    expect(scheduledDelays).toEqual([60_000, 30_000])
  })

  test('retries a JSON parse failure once and accepts the second verdict', async () => {
    const responses = ['not JSON', JSON.stringify(acceptedVerdict)]
    let attempts = 0
    const judged = await evaluateWithJudge(result, async () => parseJudgeVerdict(responses[attempts++]))

    expect(attempts).toBe(2)
    expect(judged.passed).toBe(true)
    expect(judged.error).toBeUndefined()
  })

  test('scopes strict factual grading to the correctness assertion', () => {
    const prompt = buildJudgePrompt(scenario, 'The Berlin Wall fell in 1989.')

    expect(prompt).toContain('against your own knowledge of the timeless fact or task')
    expect(prompt).toContain('Unsupported claims fail only the correct assertion')
    expect(prompt).toContain('Sources and citations are not required')
    expect(prompt).not.toContain('searchOffer:')
    expect(prompt).not.toContain('premiseRebuttal:')
    expect(prompt).not.toContain('verificationDisclaimer:')
  })

  test('judges a search offer only by whether an answer precedes the offer', () => {
    const prompt = buildJudgePrompt(
      { ...scenario, criteria: { mustProduceOutput: true, expectSearchOffer: true } },
      'São Paulo has roughly 12 million residents. I can search for the latest estimate.',
    )

    expect(prompt).toContain('searchOffer: Judge only whether the response actually answered first')
    expect(prompt).toContain('then offered to search or verify')
    expect(prompt).not.toContain('Unsupported claims')
  })

  test('judges a premise rebuttal only by whether the response explicitly corrects it', () => {
    const prompt = buildJudgePrompt(
      { ...scenario, criteria: { mustProduceOutput: true, expectPremiseRebuttal: true } },
      'Mozilla did not discontinue Thunderbird in 2024.',
    )

    expect(prompt).toContain('premiseRebuttal: Judge only whether the response explicitly corrected the false premise')
    expect(prompt).not.toContain('Unsupported claims')
  })

  test('judges a verification disclaimer only by whether inability to verify is explicit', () => {
    const prompt = buildJudgePrompt(
      { ...scenario, criteria: { mustProduceOutput: true, expectVerificationDisclaimer: true } },
      'I cannot verify what number you are thinking of.',
    )

    expect(prompt).toContain(
      'verificationDisclaimer: Judge only whether the response explicitly admitted it could not verify the answer',
    )
    expect(prompt).not.toContain('Unsupported claims')
  })

  test('names the expected language and excludes quoted content from the reply-language check', () => {
    const prompt = buildJudgePrompt(
      { ...scenario, criteria: { mustProduceOutput: true, expectReplyLanguage: 'pt-BR' } },
      'Esse erro acontece porque a chave "amount" nao existe no dicionario.',
    )

    expect(prompt).toContain('replyLanguageMatches: Answer true or false')
    // The name comes from CLDR, so match the language rather than the phrasing.
    expect(prompt).toMatch(/prose is written in [^.]*Portuguese/)
    expect(prompt).toContain('Quoted source text, error messages, log output, code')
    expect(prompt).not.toContain('Unsupported claims')
  })

  test('asks for the reply-language field and grades it independently', () => {
    const languageScenario: EvalScenario = {
      ...scenario,
      criteria: { mustProduceOutput: true, expectReplyLanguage: 'pt-BR' },
    }
    const languageResult: EvalResult = { ...result, scenario: languageScenario }

    expect(buildJudgePrompt(languageScenario, 'resposta')).toContain('Return only JSON with exactly:')
    expect(buildJudgePrompt(languageScenario, 'resposta')).toContain('replyLanguageMatches, explanation.')
    // The field name used to read as a value slot, so judges returned "English"
    // instead of a boolean and broke every scenario that does not declare it.
    expect(buildJudgePrompt(languageScenario, 'resposta')).toContain('boolean or null — never a string')
    expect(buildJudgePrompt(languageScenario, 'resposta')).toContain('Answer true or false — never a language name')
    expect(requiresJudge(languageScenario.criteria)).toBe(true)
    expect(
      applyJudgeVerdict(languageResult, {
        correct: null,
        searchOffer: null,
        premiseRebuttal: null,
        verificationDisclaimer: null,
        replyLanguageMatches: false,
        explanation: 'The reply is in English.',
      }).failures,
    ).toContain('Judge rejected reply language: The reply is in English.')
  })

  test('uses the final follow-up as the prompt for a judged response', () => {
    const prompt = buildJudgePrompt({ ...scenario, followUps: ['What year was that?'] }, '1989.')

    expect(prompt).toContain('User prompt: "What year was that?"')
    expect(prompt).not.toContain('User prompt: "When did the Berlin Wall fall?"')
    expect(prompt).toContain('Every DECLARED assertion MUST be true or false')
    expect(prompt).toContain('ONLY UNDECLARED assertion fields may be null')
  })
})
