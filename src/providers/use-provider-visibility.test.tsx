/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getAllModels } from '@/dal/models'
import { saveProviderConnection, getProviderConnections } from '@/dal/provider-connections'
import { useSettings } from '@/hooks/use-settings'
import { useModelsPageState } from '@/settings/models/use-models-page-state'
import { useAiProviderConnections } from '@/settings/connections/use-ai-provider-connections'
import { useSearchProviderAvailability } from '@/integrations/standalone-search/use-search-provider-availability'
import { useOnboardingModelState } from '@/components/onboarding/use-onboarding-model-state'
import * as capabilities from '@/integrations/otari-search/capabilities'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { addProviderModels } from './models'

beforeEach(resetTestDatabase)
afterAll(teardownTestDatabase)
afterEach(() => {
  cleanup()
  mock.restore()
})

it('hides saved Otari data by default and reactively reveals it across all provider surfaces', async () => {
  const id = await saveProviderConnection(getDb(), {
    provider: 'otari',
    name: 'Preview Otari',
    authMethod: 'api_key',
    url: 'http://localhost:8099/api/v1',
    credentials: { apiKey: 'test' },
  })
  await addProviderModels(getDb(), id, [{ id: 'test-model' }])
  const discovery = spyOn(capabilities, 'loadOtariSearchStatus').mockResolvedValue('available')
  const { result } = renderHook(
    () => ({
      flag: useSettings({ experimental_feature_otari: false }).experimentalFeatureOtari,
      models: useModelsPageState(),
      connections: useAiProviderConnections(),
      search: useSearchProviderAvailability(),
      onboarding: useOnboardingModelState(),
    }),
    { wrapper: createTestProvider() },
  )
  const settle = () =>
    act(async () => {
      await getClock().runAllAsync()
    })
  await settle()
  const expectVisible = (visible: boolean) => {
    expect(result.current.models.models.some((model) => model.provider === 'otari')).toBe(visible)
    expect(result.current.connections.providers.some((connection) => connection.id === id)).toBe(visible)
    expect(result.current.search.connections.some((connection) => connection.id === id)).toBe(visible)
    expect(result.current.onboarding.connectedProviders.includes('otari')).toBe(visible)
  }
  expect(result.current.flag.value).toBe(false)
  expectVisible(false)
  expect(discovery).not.toHaveBeenCalled()
  await act(async () => {
    await result.current.flag.setValue(true)
  })
  await settle()
  expectVisible(true)
  await act(async () => {
    await result.current.flag.setValue(false)
  })
  await settle()
  expectVisible(false)
  expect(await getProviderConnections(getDb())).toHaveLength(1)
  expect(await getAllModels(getDb())).toHaveLength(1)
})
