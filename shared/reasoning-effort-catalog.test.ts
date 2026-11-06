/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { parseTinfoilReasoningCatalog } from './reasoning-effort-catalog'
import { reasoningEfforts } from './reasoning-effort'

it('reads exact native metadata for new models without interpreting lossy preset maps', () => {
  const catalog = parseTinfoilReasoningCatalog({
    data: [
      {
        id: 'new-model',
        reasoning: true,
        supported_efforts: ['max', 'high', 'low', 'high', 'future'],
        reasoning_params: { effort_map: { high: 'xhigh', medium: 'high', low: 'low' } },
      },
      { id: 'full-scale', reasoning: true, supported_efforts: [...reasoningEfforts] },
      { id: 'off-only', reasoning: true, supported_efforts: ['none'] },
    ],
  })
  expect(catalog.get('new-model')).toEqual({ efforts: ['low', 'high', 'max'] })
  expect(catalog.get('full-scale')).toEqual({ efforts: reasoningEfforts })
  expect(catalog.get('off-only')).toEqual({ efforts: ['none'] })
  expect(catalog.get('unknown')).toBeUndefined()
})

it.each([
  {},
  { reasoning: true },
  { reasoning: true, supported_efforts: null },
  { reasoning: true, supported_efforts: [] },
  { reasoning: true, supported_efforts: ['future', 'off'] },
  { reasoning: false, supported_efforts: ['high'] },
  { supported_efforts: ['high'] },
])('does not infer native support from missing or unavailable metadata (%j)', (metadata) => {
  expect(parseTinfoilReasoningCatalog({ data: [{ id: 'model', ...metadata }] }).get('model')).toEqual({ efforts: [] })
})

it.each([
  null,
  {},
  { data: {} },
  { data: [null] },
  { data: [{ id: 1 }] },
  { data: [{ id: 'm', reasoning: 'true' }] },
  { data: [{ id: 'm', supported_efforts: 'high' }] },
  { data: [{ id: 'm', supported_efforts: ['high', 1] }] },
])('rejects malformed catalogs instead of assuming capability support (%j)', (catalog) => {
  expect(() => parseTinfoilReasoningCatalog(catalog)).toThrow('Invalid Tinfoil model')
})
