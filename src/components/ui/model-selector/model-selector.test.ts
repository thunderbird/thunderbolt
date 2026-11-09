/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { categorizeModels } from './model-selector'
import { needsApiKey } from '@/settings/models/model-policy'
import type { Model } from '@/types'

const makeModel = (overrides: Partial<Model> & { id: string; name: string }): Model =>
  ({
    model: 'test-model',
    provider: 'thunderbolt',
    enabled: 1,
    toolUsage: 'auto',
    isConfidential: 0,
    startWithReasoning: 0,
    supportsParallelToolCalls: 1,
    isSystem: 1,
    apiKey: null,
    ...overrides,
  }) as Model

const confidentialModel = makeModel({ id: 'conf-1', name: 'GPT Confidential', isConfidential: 1 })
const standardModel = makeModel({ id: 'std-1', name: 'Mistral Standard', isConfidential: 0 })
const customModel = makeModel({ id: 'custom-1', name: 'Custom Model', isConfidential: 0, isSystem: 0 })

describe('categorizeModels', () => {
  test('combines models regardless of their legacy confidentiality flag', () => {
    const groups = categorizeModels([confidentialModel, standardModel, customModel])

    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('available')
    expect(groups[0].items.map((item) => item.id)).toEqual(['conf-1', 'std-1', 'custom-1'])
    expect(groups[0].items.every((item) => !item.disabled && !item.icon)).toBe(true)
  })

  test('disables a model that still needs an API key', () => {
    const missingKey = makeModel({ id: 'openai', name: 'OpenAI', provider: 'openai', isSystem: 0 })
    const groups = categorizeModels([confidentialModel, missingKey])

    expect(groups[0].items[0].disabled).toBe(false)
    expect(groups[0].items[1].disabled).toBe(true)
  })

  test('empty models returns empty groups', () => {
    expect(categorizeModels([])).toEqual([])
  })
})

describe('needsApiKey', () => {
  test('system tinfoil rows do not need a key (injected by backend proxy)', () => {
    const model = makeModel({
      id: 'tinfoil-system',
      name: 'GLM 5.2',
      provider: 'tinfoil',
      isSystem: 1,
      apiKey: null,
    })
    expect(needsApiKey(model)).toBe(false)
  })

  test('user-added tinfoil rows with a key do not need one', () => {
    const model = makeModel({
      id: 'tinfoil-byok-ok',
      name: 'My Tinfoil',
      provider: 'tinfoil',
      isSystem: 0,
      apiKey: 'tk-user',
    })
    expect(needsApiKey(model)).toBe(false)
  })

  test('user-added tinfoil rows without a key need one', () => {
    const model = makeModel({
      id: 'tinfoil-byok-missing',
      name: 'My Tinfoil',
      provider: 'tinfoil',
      isSystem: 0,
      apiKey: null,
    })
    expect(needsApiKey(model)).toBe(true)
  })

  test('non-thunderbolt/non-custom providers without a key need one', () => {
    const model = makeModel({
      id: 'openai-missing',
      name: 'OpenAI',
      provider: 'openai',
      isSystem: 0,
      apiKey: null,
    })
    expect(needsApiKey(model)).toBe(true)
  })
})
