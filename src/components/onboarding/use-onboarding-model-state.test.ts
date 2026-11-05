/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createModel, getModel } from '@/dal/models'
import { getDb } from '@/db/database'
import { getClock } from '@/testing-library'
import { isStandaloneModelReady } from '@/settings/models/model-policy'
import { createTestProvider } from '@/test-utils/test-provider'
import { createMockModel, resetStore } from '@/test-utils/chat-store-mocks'
import { isConfiguredStandaloneModel, useOnboardingModelState } from './use-onboarding-model-state'

describe('standalone onboarding model requirement', () => {
  it('accepts local models without an API key and configured cloud providers', () => {
    expect(
      isConfiguredStandaloneModel(
        createMockModel({
          provider: 'custom',
          isSystem: 0,
          url: 'http://localhost:11434/v1',
          apiKey: null,
        }),
      ),
    ).toBe(true)
    expect(
      isConfiguredStandaloneModel(
        createMockModel({
          provider: 'openai',
          isSystem: 0,
          apiKey: 'user-key',
        }),
      ),
    ).toBe(true)
  })

  it('rejects hosted defaults, missing credentials, and unusable models', () => {
    const local = createMockModel({ provider: 'custom', isSystem: 0, url: 'http://localhost:11434/v1', apiKey: null })
    expect(isConfiguredStandaloneModel(createMockModel({ provider: 'thunderbolt', isSystem: 1 }))).toBe(false)
    expect(isConfiguredStandaloneModel(createMockModel({ provider: 'tinfoil', isSystem: 1 }))).toBe(false)
    expect(isConfiguredStandaloneModel(createMockModel({ provider: 'openai', isSystem: 0, apiKey: null }))).toBe(false)
    expect(isConfiguredStandaloneModel({ ...local, url: '' })).toBe(false)
    expect(isConfiguredStandaloneModel({ ...local, model: ' ' })).toBe(false)
    expect(isConfiguredStandaloneModel({ ...local, enabled: 0 })).toBe(false)
    expect(isConfiguredStandaloneModel({ ...local, deletedAt: '2026-10-23T00:00:00.000Z' })).toBe(false)
  })
})

describe('provider disconnect', () => {
  beforeAll(setupTestDatabase)
  beforeEach(resetStore)
  afterAll(teardownTestDatabase)
  afterEach(async () => {
    cleanup()
    resetStore()
    await resetTestDatabase()
  })

  it('shows a key-bearing disabled model as connected without treating it as runnable', async () => {
    await createModel(getDb(), {
      id: 'disabled',
      name: 'Disabled model',
      provider: 'openrouter',
      model: 'default-model',
      apiKey: 'key',
      enabled: 0,
    })
    const { result } = renderHook(useOnboardingModelState, { wrapper: createTestProvider() })
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(result.current.connectedModels.map((model) => model.id)).toEqual(['disabled'])
    expect(result.current.configuredModels).toEqual([])
    expect(result.current.hasConfiguredModel).toBe(false)
    expect((await getModel(getDb(), 'disabled'))?.enabled).toBe(0)
  })

  it('clears models added after the disconnect handler rendered, retaining other providers', async () => {
    const { result } = renderHook(() => useOnboardingModelState(), { wrapper: createTestProvider() })
    const disconnect = result.current.disconnectProvider
    await createModel(getDb(), {
      id: 'late-model',
      providerDefault: 1,
      provider: 'openrouter',
      name: 'Late model',
      model: 'model',
      apiKey: 'key',
    })
    await createModel(getDb(), {
      id: 'other-provider',
      provider: 'openrouter',
      name: 'Other model',
      model: 'model',
      apiKey: 'other-key',
    })
    await act(async () => {
      await disconnect('openrouter')
    })
    expect(await getModel(getDb(), 'late-model')).toMatchObject({ enabled: 1, apiKey: null, deletedAt: null })
    expect(await getModel(getDb(), 'other-provider')).toMatchObject({ enabled: 1, apiKey: 'other-key' })
  })
  it('removes keys without overwriting enabled preferences or other providers', async () => {
    const db = getDb()
    for (const enabled of [0, 1]) {
      await createModel(db, {
        id: `router-${enabled}`,
        name: `Router model ${enabled}`,
        providerDefault: 1,
        provider: 'openrouter',
        model: 'default-model',
        enabled,
        apiKey: 'router-key',
      })
    }
    await createModel(db, {
      id: 'other',
      name: 'Other model',
      provider: 'openai',
      model: 'other-model',
      enabled: 1,
      apiKey: 'other-key',
    })
    const { result } = renderHook(useOnboardingModelState, { wrapper: createTestProvider() })
    await act(async () => {
      await result.current.disconnectProvider('openrouter')
    })
    for (const enabled of [0, 1]) {
      const model = (await getModel(db, `router-${enabled}`))!
      expect(model.enabled).toBe(enabled)
      expect(model.apiKey).toBeNull()
      expect(isStandaloneModelReady(model)).toBe(false)
    }
    expect((await getModel(db, 'other'))?.apiKey).toBe('other-key')
  })
})
