/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { i18n } from '@lingui/core'
import { categorizeModels } from './model-selector'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { setAuthToken, clearAuthToken } from '@/lib/auth-token'
import { needsApiKey } from '@/settings/models/model-policy'
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

/** `.find()` a group by id, failing the test loudly when it's absent. */
const groupById = (groups: ReturnType<typeof categorizeModels>, id: string) => {
  const group = groups.find((g) => g.id === id)
  if (!group) {
    throw new Error(`expected a '${id}' group`)
  }
  return group
}

describe('categorizeModels', () => {
  test('no chat thread: all models are available in one group, no disabled sections', () => {
    const groups = categorizeModels([confidentialModel, standardModel, customModel], null, i18n)

    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('available')
    expect(groups[0].items).toHaveLength(3)
    expect(groups[0].items.every((i) => !i.disabled)).toBe(true)
  })

  test.each([confidentialChat, standardChat])(
    'offers all configured models regardless of legacy chat flag %p',
    (thread) => {
      const groups = categorizeModels([confidentialModel, standardModel, customModel], thread, i18n)
      expect(groups).toHaveLength(1)
      expect(groupById(groups, 'available').items.map((item) => item.id)).toEqual(['conf-1', 'std-1', 'custom-1'])
      expect(groups[0].items.every((item) => !item.disabled)).toBe(true)
    },
  )

  test('custom models merge into the same group as built-in models', () => {
    const groups = categorizeModels([standardModel, customModel], null, i18n)

    expect(groups).toHaveLength(1)
    expect(groups[0].items.map((i) => i.id)).toEqual(['std-1', 'custom-1'])
  })

  test('empty models returns empty groups', () => {
    const groups = categorizeModels([], null, i18n)
    expect(groups).toHaveLength(0)
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

describe('standalone model visibility', () => {
  test('omits all hosted entries, including those in disabled confidentiality groups', () => {
    const own = makeModel({
      id: 'own',
      name: 'OpenRouter default',
      provider: 'openrouter',
      apiKey: 'own-key',
      isSystem: 0,
    })
    const managed = makeModel({
      id: 'managed',
      name: 'Managed Tinfoil',
      provider: 'tinfoil',
      isSystem: 1,
      isConfidential: 1,
    })
    const groups = categorizeModels([standardModel, confidentialModel, managed, own], null, i18n, '')
    expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual(['own'])
    const privateGroups = categorizeModels([standardModel, confidentialModel, managed, own], confidentialChat, i18n, '')
    expect(privateGroups.flatMap((group) => group.items.map((item) => item.id))).toEqual(['own'])
    expect(categorizeModels([standardModel, managed], null, i18n, '')).toEqual([])
  })

  test('reveals hosted models only after the locally chosen server is authenticated', () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example/v1', localMode: true })
    expect(categorizeModels([standardModel], null, i18n)).toEqual([])
    setAuthToken('cloud-session')
    expect(categorizeModels([standardModel], null, i18n)[0].items[0].id).toBe(standardModel.id)
    clearAuthToken()
    expect(categorizeModels([standardModel], null, i18n)).toEqual([])
  })
})
