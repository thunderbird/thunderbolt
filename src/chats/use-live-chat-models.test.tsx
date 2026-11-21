/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createModel, updateModel } from '@/dal/models'
import { saveIntegrationCredentials } from '@/dal/integrations'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { isModelReady } from '@/settings/models/model-policy'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { useChatStore } from './chat-store'
import { useLiveChatModels } from './use-live-chat-models'

const Harness = () => {
  useLiveChatModels()
  return null
}

const settle = () => act(async () => getClock().runAllAsync())
const modelIds = () =>
  useChatStore
    .getState()
    .models.map(({ id }) => id)
    .sort()

describe('live chat model availability', () => {
  const settings = useLocalSettingsStore.getState()
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    await resetTestDatabase()
    resetStore()
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
    await createModel(getDb(), {
      id: 'oauth',
      name: 'Subscription',
      provider: 'tinfoil',
      model: 'test',
      oauthProvider: 'tinfoil',
      enabled: 1,
    })
    await createModel(getDb(), {
      id: 'byok',
      name: 'Own key',
      provider: 'tinfoil',
      model: 'test',
      apiKey: 'own-key',
      enabled: 1,
    })
    await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'account-token' }, true)
  })
  afterEach(() => {
    cleanup()
    resetStore()
    useLocalSettingsStore.setState(settings)
  })

  it.each(['disable', 'disconnect', 'reauth'] as const)(
    'updates an open chat after an external OAuth %s, preserves BYOK, and restores on reconnect',
    async (change) => {
      const { triggerChange } = renderWithReactivity(<Harness />, {
        tables: ['models', 'models_secrets', 'integrations_secrets'],
      })
      await settle()
      expect(modelIds()).toEqual(['byok', 'oauth'])
      await saveIntegrationCredentials(
        getDb(),
        'tinfoil',
        {
          access_token: change === 'disconnect' ? '' : 'account-token',
          reauth_required: change === 'reauth',
        },
        change !== 'disable',
      )
      triggerChange(['integrations_secrets'])
      await settle()
      expect(modelIds()).toEqual(['byok'])
      await saveIntegrationCredentials(getDb(), 'tinfoil', { access_token: 'reconnected-token' }, true)
      triggerChange(['integrations_secrets'])
      await settle()
      expect(modelIds()).toEqual(['byok', 'oauth'])
    },
  )

  it('observes per-model toggles and local key removal without navigation or sending', async () => {
    const { triggerChange } = renderWithReactivity(<Harness />, {
      tables: ['models', 'models_secrets', 'integrations_secrets'],
    })
    await settle()
    await updateModel(getDb(), 'byok', { enabled: 0 })
    triggerChange(['models'])
    await settle()
    expect(modelIds()).toEqual(['oauth'])
    await updateModel(getDb(), 'byok', { enabled: 1, apiKey: null })
    triggerChange(['models_secrets'])
    await settle()
    const model = useChatStore.getState().models.find(({ id }) => id === 'byok')!
    expect(model.apiKey).toBeNull()
    expect(isModelReady(model)).toBe(false)
  })

  it('ignores callbacks after the chat surface unmounts', async () => {
    const { triggerChange, rerender } = renderWithReactivity(<Harness />, {
      tables: ['models', 'models_secrets', 'integrations_secrets'],
    })
    await settle()
    rerender(<></>)
    useChatStore.getState().setModels([])
    triggerChange(['integrations_secrets'])
    await settle()
    expect(modelIds()).toEqual([])
  })
})
