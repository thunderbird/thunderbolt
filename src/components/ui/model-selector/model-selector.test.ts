/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { categorizeModels, needsApiKey } from './model-selector'
import type { Model } from '@/types'
import type { ChatThread } from '@/layout/sidebar/types'

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

const confidentialChat = { isEncrypted: 1 } as ChatThread
const standardChat = { isEncrypted: 0 } as ChatThread

describe('categorizeModels', () => {
  test('no chat thread: all models are available, no disabled sections', () => {
    const groups = categorizeModels([confidentialModel, standardModel, customModel], null)

    expect(groups).toHaveLength(2)
    expect(groups[0].id).toBe('provided')
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].items.every((i) => !i.disabled)).toBe(true)
    expect(groups[1].id).toBe('custom')
    expect(groups[1].items).toHaveLength(1)
    expect(groups[1].items[0].disabled).toBe(false)
  })

  test('encrypted chat: standard models in disabled section', () => {
    const groups = categorizeModels([confidentialModel, standardModel], confidentialChat)

    const provided = groups.find((g) => g.id === 'provided')
    expect(provided).toBeDefined()
    expect(provided!.items).toHaveLength(1)
    expect(provided!.items[0].id).toBe('conf-1')
    expect(provided!.items[0].disabled).toBe(false)

    const disabled = groups.find((g) => g.id === 'standard-disabled')
    expect(disabled).toBeDefined()
    expect(disabled!.label).toBeUndefined()
    expect(disabled!.subtitle).toBeUndefined()
    expect(disabled!.items).toHaveLength(1)
    expect(disabled!.items[0].id).toBe('std-1')
    expect(disabled!.items[0].disabled).toBe(true)
  })

  test('standard chat: encrypted models in disabled section', () => {
    const groups = categorizeModels([confidentialModel, standardModel], standardChat)

    const provided = groups.find((g) => g.id === 'provided')
    expect(provided).toBeDefined()
    expect(provided!.items).toHaveLength(1)
    expect(provided!.items[0].id).toBe('std-1')

    const disabled = groups.find((g) => g.id === 'confidential-disabled')
    expect(disabled).toBeDefined()
    expect(disabled!.label).toBeUndefined()
    expect(disabled!.subtitle).toBeUndefined()
    expect(disabled!.items).toHaveLength(1)
    expect(disabled!.items[0].id).toBe('conf-1')
    expect(disabled!.items[0].disabled).toBe(true)
  })

  test('custom models are grouped separately when available', () => {
    const groups = categorizeModels([standardModel, customModel], null)

    expect(groups.find((g) => g.id === 'provided')!.items).toHaveLength(1)
    expect(groups.find((g) => g.id === 'custom')!.items).toHaveLength(1)
  })

  test('disabled custom models go to the disabled section', () => {
    const groups = categorizeModels([confidentialModel, customModel], confidentialChat)

    const disabled = groups.find((g) => g.id === 'standard-disabled')
    expect(disabled).toBeDefined()
    expect(disabled!.items).toHaveLength(1)
    expect(disabled!.items[0].id).toBe('custom-1')
  })

  test('empty models returns empty groups', () => {
    const groups = categorizeModels([], null)
    expect(groups).toHaveLength(0)
  })
})

describe('needsApiKey', () => {
  test('system tinfoil rows do not need a key (injected by backend proxy)', () => {
    const model = makeModel({
      id: 'tinfoil-system',
      name: 'DeepSeek V4 Pro',
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
