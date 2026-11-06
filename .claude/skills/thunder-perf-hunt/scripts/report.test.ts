/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { mergeAcrossBrowsers } from './report'
import type { Finding } from './lib/types'

/** A browser observation with an intentionally colliding, truncated legacy id. */
const observation = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'same-truncated-id', category: 'console-error', title: 'Console error on chat',
  severity: 'medium', confidence: 'high', status: 'candidate', browsers: ['chromium'],
  scenarios: ['chat'], evidence: 'First error', issueIdentity: 'First error',
  sourceAttribution: 'app.ts:10', repro: 'chromium repro', ...overrides,
})

describe('mergeAcrossBrowsers', () => {
  it('keeps different exceptions and errors at the same source distinct with unique ids', () => {
    for (const category of ['crash', 'console-error'] as const) {
      const findings = mergeAcrossBrowsers([
        observation({ category }), observation({ category, issueIdentity: 'Second error', evidence: 'Second error' }),
      ])
      expect(findings).toHaveLength(2)
      expect(new Set(findings.map(({ id }) => id)).size).toBe(2)
    }
  })
  it('keeps different accessibility rules on the same element distinct', () => {
    expect(mergeAcrossBrowsers([
      observation({ category: 'a11y', issueIdentity: 'label' }),
      observation({ category: 'a11y', issueIdentity: 'contrast' }),
    ])).toHaveLength(2)
  })
  it('merges matching issues across browsers with evidence and repro from the strongest observation', () => {
    const first = observation()
    const strongest = observation({ browsers: ['firefox'], severity: 'critical', evidence: 'Worst evidence', repro: 'firefox repro' })
    const forward = mergeAcrossBrowsers([first, strongest])
    const reverse = mergeAcrossBrowsers([strongest, first])
    expect(forward).toHaveLength(1)
    expect(forward[0]).toMatchObject({ severity: 'critical', evidence: 'Worst evidence', repro: 'firefox repro', browsers: ['chromium', 'firefox'] })
    expect(reverse[0]?.id).toBe(forward[0]?.id)
  })
  it('keeps the same issue in different scenarios distinct', () => {
    expect(mergeAcrossBrowsers([observation(), observation({ scenarios: ['settings'] })])).toHaveLength(2)
  })
})
