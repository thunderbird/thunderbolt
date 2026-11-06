/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import type { Model } from '@/types'
import { canSupplyTinfoilSearch, hasTinfoilSearchConnection } from './eligibility'

const byok = (overrides: Partial<Model> = {}) =>
  createMockModel({ provider: 'tinfoil', isSystem: 0, enabled: 1, apiKey: 'own-key', toolUsage: 0, ...overrides })

it('keeps OAuth search independent of the model list', () => {
  expect(hasTinfoilSearchConnection([], true)).toBe(true)
  expect(hasTinfoilSearchConnection([], false)).toBe(false)
  expect(hasTinfoilSearchConnection([byok({ oauthProvider: 'tinfoil', apiKey: null })], false)).toBe(false)
})

it('uses BYOK search even when the model does not support tool calling', () => {
  expect(canSupplyTinfoilSearch(byok())).toBe(true)
  expect(hasTinfoilSearchConnection([byok()], false)).toBe(true)
})

it.each([
  { enabled: 0 },
  { deletedAt: '2026-01-01' },
  { provider: 'openai' as const },
  { isSystem: 1 },
  { apiKey: null },
  { oauthProvider: 'tinfoil' as const },
])('excludes ineligible BYOK model %j', (overrides) => {
  expect(canSupplyTinfoilSearch(byok(overrides))).toBe(false)
})
