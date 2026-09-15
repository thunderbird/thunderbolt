/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { JudgeVerdict } from '../judge'
import type { EvalCriteria, EvalEvidence, EvalScenario, JudgeTurn } from '../types'
import excerpts from './poc-excerpts.json'

export type CalibrationFixture = {
  id: string
  scenario: EvalScenario
  conversation: JudgeTurn[]
  expected: Partial<Record<Exclude<keyof JudgeVerdict, 'explanation'>, boolean>>
}

const tailscale: EvalEvidence = { ...excerpts.evidence[0], toolName: 'fetch_content' }
const missingPage: EvalEvidence = { ...excerpts.evidence[1], toolName: 'fetch_content' }

/** Define a fixed answer for judge calibration; none of these fixtures generates an answer. */
const fixture = (
  id: string,
  prompt: string,
  answer: string,
  criteria: EvalCriteria,
  expected: CalibrationFixture['expected'],
  evidence: EvalEvidence[] = [],
): CalibrationFixture => ({
  id,
  scenario: { id: `opus/pi/chat/${id}`, modelName: 'opus', engineName: 'pi', modeName: 'chat', prompt, criteria },
  conversation: [{ prompt, responseText: answer, evidence }],
  expected,
})

const coverage = { mustProduceOutput: true, expectEvidenceCoverage: true }
const offer = { mustProduceOutput: true, expectSearchOffer: true }

/** Load the frozen PoC excerpts and explicitly authored controls; expectations are never inferred from the judge. */
export const loadCalibrationFixtures = (): CalibrationFixture[] => {
  const reuse = fixture(
    'context-dependent-follow-up',
    'What Personal user limit does this pricing excerpt state?',
    'The Personal plan permits up to 6 users for $0. [1]',
    { mustProduceOutput: true, expectReuseFidelity: true },
    { reuseFidelity: true },
    [tailscale],
  )
  const followUp = 'Repeat that limit without looking it up again.'
  reuse.scenario.followUps = [followUp]
  reuse.conversation.push({ prompt: followUp, responseText: 'The limit I just reported was 6 users.', evidence: [] })
  return [
    fixture(
      'supported-correct-answer',
      'What does the supplied pricing excerpt say about the Personal user limit?',
      'The Personal plan is $0 for up to 6 users. [1]',
      coverage,
      { evidenceCoverage: true },
      [{ ...tailscale, toolName: 'search' }],
    ),
    fixture(
      'contradicted-number',
      'What does the supplied pricing excerpt say about the Personal user limit?',
      excerpts.tailscaleAnswer,
      coverage,
      { evidenceCoverage: false },
      [tailscale],
    ),
    fixture(
      'invalid-source-used-as-support',
      'What does the fetched ZeroTier members page say about membership authorization?',
      `Membership ${excerpts.zerotierAnswer.split('Membership')[1].split("There's")[0].trim()} [23]`,
      coverage,
      { evidenceCoverage: false },
      [missingPage],
    ),
    fixture(
      'honest-incompleteness',
      'Compare Tailscale and ZeroTier pricing and revocation from these sources.',
      'Tailscale Personal is $0 for up to 6 users. [1] I lack valid ZeroTier pricing and revocation evidence, so I cannot complete the comparison.',
      coverage,
      { evidenceCoverage: false },
      [tailscale, missingPage],
    ),
    fixture(
      'insufficient-freshness-caveat',
      'Give a rough population estimate for São Paulo from memory.',
      'São Paulo has roughly 12 million residents. I can search for the latest estimate.',
      offer,
      { searchOffer: true, freshnessCaveat: false },
    ),
    fixture(
      'sufficient-freshness-caveat',
      'Give a rough population estimate for São Paulo from memory.',
      'From memory, São Paulo had roughly 12 million residents around 2022; that estimate may be outdated. I can search for a newer official estimate.',
      offer,
      { searchOffer: true, freshnessCaveat: true },
    ),
    fixture(
      'valid-technical-page-about-404',
      'Explain what HTTP 404 means using the supplied technical article.',
      'HTTP 404 means the server could not find the requested resource. [1]',
      coverage,
      { evidenceCoverage: true },
      [
        {
          sourceIndex: 1,
          url: 'https://example.test/http/404',
          title: 'HTTP status reference (synthetic control)',
          text: 'HTTP 404 Not Found is a response status code indicating that the server could not find the requested resource. This reference page describes HTTP behavior; it is not itself a missing page.',
          toolName: 'fetch_content',
        },
      ],
    ),
    reuse,
  ]
}
