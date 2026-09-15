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
  semanticVerdicts,
  requiresJudge,
} from './judge'
import { evalModels } from './scenarios'
import { semanticCriterionKeys, type EvalResult, type EvalScenario } from './types'

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
  freshnessCaveat: null,
  evidenceCoverage: null,
  reuseFidelity: null,
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
          freshnessCaveat: null,
          evidenceCoverage: null,
          reuseFidelity: null,
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
      freshnessCaveat: null,
      evidenceCoverage: null,
      reuseFidelity: null,
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
        freshnessCaveat: null,
        evidenceCoverage: null,
        reuseFidelity: null,
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

    expect(attempts).toBe(2)
    expect(judged.passed).toBe(false)
    expect(judged.error).toBe('Judge error: upstream unavailable')
    expect(judged.failures).toContain('Judge error: upstream unavailable')
  })

  test('aborts a hanging judge attempt when its timeout expires', async () => {
    const firstReady = Promise.withResolvers<() => void>()
    const secondReady = Promise.withResolvers<() => void>()
    const schedulers = [firstReady, secondReady]
    const signals: AbortSignal[] = []
    const judgedPromise = evaluateWithJudge(
      result,
      (signal) => {
        signals.push(signal)
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
      {
        attemptTimeoutMs: 60_000,
        scheduleTimeout: (callback) => {
          schedulers.shift()!.resolve(callback)
          return () => {}
        },
      },
    )
    const expireFirst = await firstReady.promise
    expireFirst()
    const expireSecond = await secondReady.promise
    expireSecond()
    const judged = await judgedPromise
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
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

  test('gives each of the two judge attempts its own deadline', async () => {
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
    expect(scheduledDelays).toEqual([60_000, 60_000])
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

  test('judges knowledge and offer separately from the freshness caveat', () => {
    const prompt = buildJudgePrompt(
      { ...scenario, criteria: { mustProduceOutput: true, expectSearchOffer: true } },
      'São Paulo has roughly 12 million residents. I can search for the latest estimate.',
    )

    expect(prompt).toContain('searchOffer: Judge only whether the response actually answered first')
    expect(prompt).toContain('then offered to search or verify')
    expect(prompt).toContain('freshnessCaveat:')
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
        freshnessCaveat: null,
        evidenceCoverage: null,
        reuseFidelity: null,
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

test('stores the whole judge verdict and replaces an earlier rejection on regrade', () => {
  const rejected = applyJudgeVerdict(result, { ...acceptedVerdict, correct: false, explanation: 'initial rejection' })
  expect(rejected.judgeVerdict?.explanation).toBe('initial rejection')
  const accepted = applyJudgeVerdict(rejected, acceptedVerdict)
  expect(accepted.passed).toBe(true)
  expect(accepted.failures).toEqual([])
  expect(accepted.judgeVerdict).toEqual(acceptedVerdict)
})

test('schema mismatch retries the same answer exactly once and records both durations', async () => {
  const responses = [JSON.stringify({ ...acceptedVerdict, extra: true }), JSON.stringify(acceptedVerdict)]
  const judged = await evaluateWithJudge(result, async () => parseJudgeVerdict(responses.shift()!))
  expect(judged.passed).toBe(true)
  expect(judged.judgeAttempts?.map(({ status }) => status)).toEqual(['judge_error', 'completed'])
  expect(judged.judgeAttempts?.every(({ durationMs }) => durationMs >= 0)).toBe(true)
  expect(judged.responseText).toBe(result.responseText)
})

test('a completed behavioural rejection is not regraded', async () => {
  const calls: number[] = []
  const judged = await evaluateWithJudge(result, async () => {
    calls.push(1)
    return { ...acceptedVerdict, correct: false }
  })
  expect(calls).toHaveLength(1)
  expect(judged.passed).toBe(false)
})

test('evidence coverage and reuse fidelity are declared and replaceable verdicts', () => {
  for (const [criteriaKey, verdictKey] of [
    ['expectEvidenceCoverage', 'evidenceCoverage'],
    ['expectReuseFidelity', 'reuseFidelity'],
  ] as const) {
    const base = { ...result, scenario: { ...scenario, criteria: { mustProduceOutput: true, [criteriaKey]: true } } }
    const rejected = applyJudgeVerdict(base, { ...acceptedVerdict, correct: null, [verdictKey]: false })
    expect(rejected.passed).toBe(false)
    const regraded = applyJudgeVerdict(rejected, { ...acceptedVerdict, correct: null, [verdictKey]: true })
    expect(regraded.passed).toBe(true)
    expect(regraded.failures).toEqual([])
    expect(semanticVerdicts(base.scenario.criteria, regraded.judgeVerdict)[criteriaKey]).toBe('pass')
  }
})

test('search offer requires knowledge-plus-offer AND freshness caveat; disclaimer is independent', () => {
  const base = { ...result, scenario: { ...scenario, criteria: { mustProduceOutput: true, expectSearchOffer: true } } }
  for (const [searchOffer, freshnessCaveat, passed] of [
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ] as const) {
    const judged = applyJudgeVerdict(base, { ...acceptedVerdict, correct: null, searchOffer, freshnessCaveat })
    expect(judged.passed).toBe(passed)
    expect(semanticVerdicts(base.scenario.criteria, judged.judgeVerdict).expectSearchOffer).toBe(
      passed ? 'pass' : 'fail',
    )
  }
  expect(() => applyJudgeVerdict(base, { ...acceptedVerdict, correct: null, searchOffer: true })).toThrow(
    'freshnessCaveat',
  )
  const disclaimer = {
    ...result,
    scenario: { ...scenario, criteria: { mustProduceOutput: true, expectVerificationDisclaimer: true } },
  }
  expect(
    applyJudgeVerdict(disclaimer, { ...acceptedVerdict, correct: null, verificationDisclaimer: true }).passed,
  ).toBe(true)
})

test('undeclared fields must stay null and missing declared fields are judge errors', () => {
  expect(() => applyJudgeVerdict(result, { ...acceptedVerdict, evidenceCoverage: true })).toThrow(
    'undeclared assertion: evidenceCoverage',
  )
  expect(() => parseJudgeVerdict(JSON.stringify({ correct: true }))).toThrow('Invalid judge verdict')
})

test('expectation text is attached to its declared assertion only', () => {
  const prompt = buildJudgePrompt(
    {
      ...scenario,
      criteria: { mustProduceOutput: true, expectCorrectAnswer: true, expectSearchOffer: true },
      expectation: { expectCorrectAnswer: 'CORRECTNESS-EXPECTATION', expectSearchOffer: 'OFFER-EXPECTATION' },
    },
    'answer',
  )
  expect(prompt.indexOf('CORRECTNESS-EXPECTATION')).toBeGreaterThan(prompt.indexOf('correct:'))
  expect(prompt.indexOf('CORRECTNESS-EXPECTATION')).toBeLessThan(prompt.indexOf('searchOffer:'))
  expect(prompt.indexOf('OFFER-EXPECTATION')).toBeGreaterThan(prompt.indexOf('searchOffer:'))
  expect(() => buildJudgePrompt({ ...scenario, expectation: { expectEvidenceCoverage: 'unbound' } }, 'answer')).toThrow(
    'undeclared assertion',
  )
})

test('evidence enters only evidence-dependent judging and citations retain their turn namespace', () => {
  const conversation = [
    {
      prompt: 'first',
      responseText: 'first fact [1]',
      evidence: [
        { sourceIndex: 1, url: 'https://first.test', title: 'First', text: 'FIRST-BODY', toolName: 'search' as const },
      ],
    },
    {
      prompt: 'second',
      responseText: 'second fact [1]',
      evidence: [
        {
          sourceIndex: 1,
          url: 'https://second.test',
          title: 'Second',
          text: 'SECOND-BODY',
          toolName: 'fetch_content' as const,
        },
      ],
    },
  ]
  const prompt = buildJudgePrompt(
    { ...scenario, criteria: { mustProduceOutput: true, expectEvidenceCoverage: true } },
    'second fact [1]',
    conversation,
  )
  for (const text of [
    'Turn 1 Source [1]',
    'Turn 2 Source [1]',
    'FIRST-BODY',
    'SECOND-BODY',
    'Turn 2 (scored)',
    'sufficient search snippet',
    'Honest incompleteness',
  ]) {
    expect(prompt).toContain(text)
  }
  expect(prompt).not.toContain('Source [2]')
  for (const criteria of [
    { mustProduceOutput: true, expectCorrectAnswer: true },
    { mustProduceOutput: true, expectReuseFidelity: true },
    { mustProduceOutput: true, expectSearchOffer: true },
  ]) {
    const without = buildJudgePrompt({ ...scenario, criteria }, 'second fact [1]', conversation)
    expect(without).toContain('first fact [1]')
    expect(without).not.toContain('FIRST-BODY')
    expect(without).not.toContain('SECOND-BODY')
  }
})

test('M1: supported expectation keys match the judge registry', () => {
  const criteria = {
    mustProduceOutput: true,
    expectCorrectAnswer: true,
    expectSearchOffer: true,
    expectEvidenceCoverage: true,
    expectReuseFidelity: true,
    expectPremiseRebuttal: true,
    expectVerificationDisclaimer: true,
    expectReplyLanguage: 'en' as const,
  }
  expect(Object.keys(semanticVerdicts(criteria)).sort()).toEqual([...semanticCriterionKeys].sort())
})
