/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { getModelDisplayName } from './model-display-name'

it('prefers the server’s display name, preserving its official spelling', () => {
  expect(getModelDisplayName({ id: 'vendor/opaque-123', name: ' DeepSeek V4.1 Flash ' })).toBe('DeepSeek V4.1 Flash')
})

it.each([
  ['deepseek/deepseek-v4.1-flash', 'Deepseek v4.1 Flash'],
  ['vendor/family-v2.5-small', 'Family v2.5 Small'],
  ['org/repo/my_model-v1', 'My Model v1'],
  ['auto', 'Auto'],
  ['vendor/SomeModel-v3', 'SomeModel v3'],
  ['gpt-4-turbo', 'Gpt 4 Turbo'],
  ['claude-3-5-sonnet', 'Claude 3 5 Sonnet'],
  ['anthropic/claude-3-haiku', 'Claude 3 Haiku'],
  ['llama3:latest', 'Llama 3'],
  ['o1-preview', 'O1 Preview'],
  ['glm-5.2', 'Glm 5.2'],
  ['vendor/Family-v1.2.3', 'Family v1.2.3'],
])('formats %s without a provider/model lookup table', (id, label) => {
  expect(getModelDisplayName({ id })).toBe(label)
  expect(getModelDisplayName({ id, name: '' })).toBe(label)
  expect(getModelDisplayName({ id, name: '  ' })).toBe(label)
  expect(getModelDisplayName({ id, name: id })).toBe(label)
})
