/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { managedAnthropicCatalogId } from './managed-model-id'

it.each([
  ['opus-5-5', 'claude-opus-5'],
  ['opus-5', 'claude-opus-5'],
  ['sonnet-4-5', 'claude-sonnet-4-5'],
])('resolves managed Anthropic %s to catalog metadata %s', (wireId, catalogId) => {
  expect(managedAnthropicCatalogId(wireId)).toBe(catalogId)
})
