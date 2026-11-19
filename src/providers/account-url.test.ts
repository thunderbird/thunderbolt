/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { getProviderAccountUrl } from './account-url'

it.each([
  ['tinfoil', 'https://dash.tinfoil.sh/'],
  ['openrouter', 'https://openrouter.ai/settings/keys'],
  ['anthropic', 'https://platform.claude.com/'],
  ['exa', 'https://dashboard.exa.ai/'],
  ['brave', 'https://api-dashboard.search.brave.com/'],
  ['tavily', 'https://app.tavily.com/'],
  ['custom', null],
] as const)('links %s to its account dashboard', (provider, expected) => {
  expect(getProviderAccountUrl({ provider, authMethod: 'api_key', url: null })).toBe(expected)
})

it('distinguishes ChatGPT and OpenAI API accounts', () => {
  expect(getProviderAccountUrl({ provider: 'openai', authMethod: 'oauth', url: null })).toBe('https://chatgpt.com/')
  expect(getProviderAccountUrl({ provider: 'openai', authMethod: 'api_key', url: null })).toBe(
    'https://platform.openai.com/',
  )
})

it('uses the connected Otari server dashboard, including local deployments', () => {
  expect(getProviderAccountUrl({ provider: 'otari', authMethod: 'oauth', url: 'http://localhost:8099/api/v1' })).toBe(
    'http://localhost:8099',
  )
  expect(getProviderAccountUrl({ provider: 'otari', authMethod: 'oauth', url: null })).toBe('https://otari.ai')
})
