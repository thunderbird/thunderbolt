/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  applyJudgeVerdict,
  buildJudgePrompt,
  evaluateWithJudge,
  getJudgeModelName,
  parseJudgeVerdict,
  requiresJudge,
} from './judge'
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

describe('judge model assignment', () => {
  test('uses Flash for Opus and Opus for Flash and GLM', () => {
    expect(getJudgeModelName('opus')).toBe('flash')
    expect(getJudgeModelName('flash')).toBe('opus')
    expect(getJudgeModelName('glm')).toBe('opus')
  })

  test('never assigns the tested model or GLM as judge', () => {
    for (const testedModel of ['opus', 'flash', 'glm']) {
      const judge = getJudgeModelName(testedModel)
      expect(judge).not.toBe(testedModel)
      expect(judge).not.toBe('glm')
    }
  })
})

describe('judge verdict parsing', () => {
  test('parses a strict JSON verdict', () => {
    expect(
      parseJudgeVerdict(
        JSON.stringify({
          correct: true,
          searchOffer: null,
          premiseRebuttal: null,
          verificationDisclaimer: null,
          explanation: 'The year is correct.',
        }),
      ),
    ).toMatchObject({ correct: true })
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
          explanation: 'ok',
          pass: true,
        }),
      ),
    ).toThrow('Invalid judge verdict')
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
        explanation: 'No verdict.',
      }),
    ).toThrow('Judge omitted declared assertion: correct')
  })

  test('marks judge failures as sample errors instead of passing', async () => {
    const judged = await evaluateWithJudge(result, async () => {
      throw new Error('upstream unavailable')
    })

    expect(judged.passed).toBe(false)
    expect(judged.error).toBe('Judge error: upstream unavailable')
    expect(judged.failures).toContain('Judge error: upstream unavailable')
  })

  test('grades a multi-turn response against the final follow-up', () => {
    const prompt = buildJudgePrompt({ ...scenario, followUps: ['What year was that?'] }, '1989.')

    expect(prompt).toContain('User prompt: "What year was that?"')
    expect(prompt).not.toContain('User prompt: "When did the Berlin Wall fall?"')
  })
})
