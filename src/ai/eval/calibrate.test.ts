/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { runCalibration } from './calibrate'
import { loadCalibrationFixtures } from './fixtures'
import type { JudgeVerdict } from './judge'

const verdictFor = (expected: Partial<JudgeVerdict>): JudgeVerdict => ({
  correct: null,
  searchOffer: null,
  freshnessCaveat: null,
  evidenceCoverage: null,
  reuseFidelity: null,
  premiseRebuttal: null,
  verificationDisclaimer: null,
  replyLanguageMatches: null,
  explanation: 'injected calibration verdict',
  ...expected,
})

test('loads all frozen fixture cases including exact PoC counterexamples', () => {
  const fixtures = loadCalibrationFixtures()
  expect(fixtures).toHaveLength(8)
  expect(new Set(fixtures.map(({ id }) => id)).size).toBe(8)
  const contradiction = fixtures.find(({ id }) => id === 'contradicted-number')!
  expect(contradiction.conversation[0].responseText).toContain('≤3 users')
  expect(contradiction.conversation[0].evidence[0].text).toContain('$0 for up to 6 users')
  const invalid = fixtures.find(({ id }) => id === 'invalid-source-used-as-support')!
  expect(invalid.conversation[0].evidence[0].text).toContain('Page Not Found')
  expect(invalid.expected.evidenceCoverage).toBe(false)
  expect(fixtures.find(({ id }) => id === 'valid-technical-page-about-404')!.expected.evidenceCoverage).toBe(true)
  expect(fixtures.find(({ id }) => id === 'honest-incompleteness')!.expected.evidenceCoverage).toBe(false)
})

test('calibration refuses without explicit opt-in before calling the injected judge', async () => {
  const calls: string[] = []
  await expect(
    runCalibration({
      enabled: false,
      evaluate: async (fixture) => {
        calls.push(fixture.id)
        return verdictFor(fixture.expected)
      },
      write: () => {},
    }),
  ).rejects.toThrow('EVAL_JUDGE_CALIBRATION=1')
  expect(calls).toHaveLength(0)
})

test('calibration reports every fixture and exits zero when injected labels match', async () => {
  const lines: string[] = []
  expect(
    await runCalibration({
      enabled: true,
      evaluate: async (fixture) => verdictFor(fixture.expected),
      write: (line) => {
        lines.push(line)
      },
    }),
  ).toBe(0)
  expect(lines).toHaveLength(10)
  expect(lines.join('\n')).not.toContain('MISMATCH')
})

test('calibration returns a nonzero mismatch exit code with an injected judge', async () => {
  const lines: string[] = []
  expect(
    await runCalibration({
      enabled: true,
      evaluate: async (fixture) =>
        verdictFor({
          ...fixture.expected,
          ...(fixture.id === 'contradicted-number' ? { evidenceCoverage: true } : {}),
        }),
      write: (line) => {
        lines.push(line)
      },
    }),
  ).toBe(1)
  expect(lines.find((line) => line.includes('contradicted-number'))).toContain('MISMATCH')
})
