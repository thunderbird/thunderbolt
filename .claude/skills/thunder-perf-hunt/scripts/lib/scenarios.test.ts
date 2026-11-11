/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { SCENARIOS, scenariosForChangedFiles } from './scenarios'

it('keeps a focused sweep when every changed file has known coverage', () => {
  const scenarios = scenariosForChangedFiles(['src/settings/preferences.tsx', 'src/settings/models.tsx'])
  expect(scenarios.length).toBeLessThan(SCENARIOS.length)
  expect(scenarios.map((scenario) => scenario.name)).toContain('settings-preferences')
  expect(new Set(scenarios).size).toBe(scenarios.length)
})

it('includes chat when a shared change accompanies a known settings change, in either order', () => {
  const files = ['src/settings/preferences.tsx', 'src/lib/http.ts']
  expect(scenariosForChangedFiles(files)).toEqual(SCENARIOS)
  expect(scenariosForChangedFiles(files.toReversed())).toEqual(SCENARIOS)
})

it('uses the full sweep for an unknown or empty change set', () => {
  expect(scenariosForChangedFiles(['shared/unknown.ts'])).toEqual(SCENARIOS)
  expect(scenariosForChangedFiles([])).toEqual(SCENARIOS)
})
