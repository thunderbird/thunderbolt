/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The harness's learned overlay — the mechanism that makes it self-improving
 * without self-complicating. It carries only two kinds of learning that are
 * safe to accumulate as data (see references/self-improve.md):
 *   - excludeSignatures: confirmed false positives to suppress, each WITH a reason.
 *   - extraScenarios: routes discovered by the crawler that deserve a probe.
 * Everything else (new probes, thresholds, logic) is a reviewed code change,
 * never a magic config value. If the file is missing/invalid, defaults apply.
 */

import { readFileSync } from 'node:fs'
import type { Finding, FindingCategory } from './types'

export type ExcludeSignature = {
  /** Optional: restrict the match to one category. */
  category?: FindingCategory
  /** Case-insensitive substring matched against the finding's title+evidence+source. */
  match: string
  /** Why this is a known false positive — required, so learnings stay auditable. */
  reason: string
}

export type CalibrationScenario = {
  name: string
  path: string
  description: string
  tags: string[]
}

export type Calibration = {
  excludeSignatures: ExcludeSignature[]
  extraScenarios: CalibrationScenario[]
}

const CALIBRATION_URL = new URL('../../calibration.json', import.meta.url)

export const loadCalibration = (): Calibration => {
  try {
    const parsed = JSON.parse(readFileSync(CALIBRATION_URL, 'utf8')) as Partial<Calibration>
    return {
      excludeSignatures: parsed.excludeSignatures ?? [],
      extraScenarios: parsed.extraScenarios ?? [],
    }
  } catch {
    return { excludeSignatures: [], extraScenarios: [] }
  }
}

/** Drop candidates matching a learned false-positive signature. */
export const applyExclusions = (findings: Finding[], cal: Calibration): Finding[] =>
  findings.filter(
    (f) =>
      !cal.excludeSignatures.some(
        (s) =>
          (!s.category || s.category === f.category) &&
          `${f.title} ${f.evidence} ${f.sourceAttribution ?? ''}`.toLowerCase().includes(s.match.toLowerCase()),
      ),
  )
