/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLocalSetting } from '@/stores/local-settings-store'
import { createProxyFetch } from '@/lib/proxy-fetch'
import { evaluateWithJudge, judgeScenario, type JudgeVerdict } from './judge'
import { loadCalibrationFixtures, type CalibrationFixture } from './fixtures'
import { scoreResult } from './scoring'
import { serializeArtifact } from './stats'

/** Explicitly opt in before any judge work; injection keeps the calibration contract testable offline. */
export const runCalibration = async ({
  enabled,
  evaluate,
  write = console.log,
}: {
  enabled: boolean
  evaluate?: (fixture: CalibrationFixture, signal: AbortSignal) => Promise<JudgeVerdict>
  write?: (line: string) => void
}): Promise<number> => {
  if (!enabled) {
    throw new Error('Judge calibration requires EVAL_JUDGE_CALIBRATION=1')
  }
  const token = process.env.EVAL_AUTH_TOKEN
  if (!evaluate && !token) {
    throw new Error('Judge calibration requires a signed EVAL_AUTH_TOKEN')
  }
  const proxyFetch = evaluate
    ? undefined
    : createProxyFetch({ cloudUrl: getLocalSetting('cloudUrl'), getProxyAuthToken: () => token ?? null })
  const grade =
    evaluate ??
    ((fixture: CalibrationFixture, signal: AbortSignal) =>
      judgeScenario(
        fixture.scenario,
        fixture.conversation.at(-1)!.responseText,
        () => proxyFetch!,
        signal,
        fixture.conversation,
      ))
  const matches: boolean[] = []
  write('| Fixture | Expected | Observed | Result |')
  write('|---|---|---|---|')
  for (const fixture of loadCalibrationFixtures()) {
    const text = fixture.conversation.at(-1)!.responseText
    const base = scoreResult(
      fixture.scenario,
      { text, toolCalls: [], assistantParts: [], stepCount: 1, retryCount: 0, finishReason: 'stop' },
      0,
    )
    const result = await evaluateWithJudge(base, (signal) => grade(fixture, signal))
    const matched =
      !result.error &&
      Object.entries(fixture.expected).every(
        ([key, value]) => result.judgeVerdict?.[key as keyof JudgeVerdict] === value,
      )
    matches.push(matched)
    const observed = result.error ?? JSON.stringify(result.judgeVerdict)
    write(
      JSON.parse(
        serializeArtifact(
          `| ${fixture.id} | ${JSON.stringify(fixture.expected)} | ${observed.replace(/[\r\n|]/g, ' ')} | ${matched ? 'pass' : 'MISMATCH'} |`,
        ),
      ) as string,
    )
  }
  return matches.every(Boolean) ? 0 : 1
}

if (import.meta.main) {
  try {
    process.exit(await runCalibration({ enabled: process.env.EVAL_JUDGE_CALIBRATION === '1' }))
  } catch (error) {
    console.error(JSON.parse(serializeArtifact(String(error))))
    process.exit(2)
  }
}
