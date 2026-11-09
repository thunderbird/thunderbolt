/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createAgent, createChatThread, createModel, getSelectedModel, getSettings, updateSettings } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { redactedApiKey } from './events'
import { i18n } from '@/i18n'
import { applyQuickEntryModel, loadQuickEntryOptions } from './quick-entry-options'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
  await reconcileDefaults(getDb())
})

describe('loadQuickEntryOptions', () => {
  it('offers the models a new chat on the built-in agent could use, with its model selected', async () => {
    await updateSettings(getDb(), { selected_model: 'keyed-model' })
    await createModel(getDb(), {
      id: 'keyed-model',
      provider: 'openai',
      name: 'Keyed',
      model: 'gpt-keyed',
      apiKey: 'sk-real-secret',
    })

    const { models, selectedModelId } = await loadQuickEntryOptions(getDb(), i18n)

    expect(models.length).toBeGreaterThan(1)
    expect(selectedModelId).toBe('keyed-model')
  })

  it('never hands over an API key, only whether one exists', async () => {
    await createModel(getDb(), { id: 'keyed', provider: 'openai', name: 'Keyed', model: 'a', apiKey: 'sk-secret' })
    await createModel(getDb(), { id: 'keyless', provider: 'openai', name: 'Keyless', model: 'b' })

    const { models } = await loadQuickEntryOptions(getDb(), i18n)

    expect(models.find((model) => model.id === 'keyed')?.apiKey).toBe(redactedApiKey)
    expect(models.find((model) => model.id === 'keyless')?.apiKey).toBeNull()
    expect(JSON.stringify(models)).not.toContain('sk-secret')
  })

  it('offers no picker when a new chat would run on an external agent', async () => {
    await createAgent(getDb(), {
      id: 'custom-agent',
      name: 'Custom',
      type: 'remote-acp',
      transport: 'websocket',
      url: 'wss://example.test/ws',
      userId: 'u1',
    })
    await updateSettings(getDb(), { selected_agent: 'custom-agent' })

    expect(await loadQuickEntryOptions(getDb(), i18n)).toMatchObject({ models: [], selectedModelId: null })
  })

  it('lists chats with display titles, leaving out Mini App chats', async () => {
    const model = await getSelectedModel(getDb())
    const thread = { contextSize: null, triggeredBy: null, wasTriggeredByAutomation: 0 }
    await createChatThread(getDb(), { ...thread, id: 'titled', title: 'Trip plans' }, model)
    await createChatThread(getDb(), { ...thread, id: 'untitled', title: null }, model)
    await createChatThread(getDb(), { ...thread, id: 'mini-app', title: 'In an app', miniAppId: 'app-1' }, model)

    const { chats } = await loadQuickEntryOptions(getDb(), i18n)

    expect(chats).toHaveLength(2)
    expect(chats).toContainEqual({ id: 'titled', title: 'Trip plans' })
    expect(chats).toContainEqual({ id: 'untitled', title: 'Untitled chat' })
  })
})

describe('applyQuickEntryModel', () => {
  it('makes the picked model the one a new chat starts on', async () => {
    await applyQuickEntryModel(getDb(), 'picked-model')

    expect((await getSettings(getDb(), { selected_model: String })).selectedModel).toBe('picked-model')
  })

  it('leaves the setting alone when no model was picked', async () => {
    await updateSettings(getDb(), { selected_model: 'existing' })

    await applyQuickEntryModel(getDb(), null)

    expect((await getSettings(getDb(), { selected_model: String })).selectedModel).toBe('existing')
  })
})
