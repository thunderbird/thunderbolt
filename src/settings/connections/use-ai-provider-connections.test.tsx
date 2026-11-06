/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as connections from '@/dal/provider-connections'
import { getModel, updateModel } from '@/dal/models'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { addProviderModels } from '@/providers/models'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { useAiProviderConnections } from './use-ai-provider-connections'

/** Keep named accounts distinct while exercising real metadata and credential persistence. */
const createConnection = (name = 'Research Otari') =>
  connections.saveProviderConnection(getDb(), {
    provider: 'otari',
    name,
    url: 'https://otari.example.com/api/v1',
    authMethod: 'api_key',
    credentials: { apiKey: 'device-key' },
  })

/** Flush React Query notifications and real SQLite reads using the shared fake clock. */
const settle = () => act(async () => getClock().runAllAsync())

/** Load both dependency queries before allowing user actions. */
const setup = async () => {
  const view = renderHook(useAiProviderConnections, { wrapper: createTestProvider() })
  await settle()
  expect(view.result.current.ready).toBe(true)
  return view
}

describe('AI provider connection disabling', () => {
  beforeEach(async () => {
    await resetTestDatabase()
    resetStore()
    useSearchProviderStore.getState().clearSearchProvider()
  })
  afterEach(() => {
    cleanup()
    mock.restore()
    resetStore()
    useSearchProviderStore.getState().clearSearchProvider()
  })
  afterAll(teardownTestDatabase)

  it('warns for a named Otari account with saved models, supports cancel, and preserves model preferences on confirmation', async () => {
    const id = await createConnection()
    const [enabledId, disabledId] = await addProviderModels(getDb(), id, [{ id: 'enabled' }, { id: 'disabled' }])
    await updateModel(getDb(), disabledId, { enabled: 0 })
    const update = spyOn(connections, 'updateProviderConnection')
    const { result } = await setup()

    act(() => result.current.toggle(id, false))
    expect(result.current.pendingDisable).toMatchObject({ id, name: 'Research Otari' })
    expect(update).not.toHaveBeenCalled()
    expect(result.current.providers[0].enabled).toBe(1)
    act(() => result.current.cancelDisable())
    expect(result.current.pendingDisable).toBeUndefined()
    expect(await connections.getProviderConnection(getDb(), id)).toMatchObject({ enabled: 1 })

    act(() => result.current.toggle(id, false))
    act(() => result.current.confirmDisable())
    expect(result.current.pendingDisable).toBeUndefined()
    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    expect(result.current.providers[0]).toMatchObject({ id, enabled: 0, connected: true })
    expect(await connections.getProviderConnection(getDb(), id)).toMatchObject({ enabled: 0, connected: true })
    expect(await getModel(getDb(), enabledId)).toMatchObject({ enabled: 1, deletedAt: null })
    expect(await getModel(getDb(), disabledId)).toMatchObject({ enabled: 0, deletedAt: null })
  })

  it('warns for a search-only account and retains the selected search preference', async () => {
    const id = await createConnection()
    useSearchProviderStore.getState().selectSearchConnection(id)
    const update = spyOn(connections, 'updateProviderConnection')
    const { result } = await setup()
    act(() => result.current.toggle(id, false))
    expect(result.current.pendingDisable?.id).toBe(id)
    expect(update).not.toHaveBeenCalled()
    act(() => result.current.confirmDisable())
    await settle()
    expect(result.current.providers[0].enabled).toBe(0)
    expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'connection', connectionId: id })
  })

  it('still warns when the only saved model is individually disabled', async () => {
    const id = await createConnection()
    const [modelId] = await addProviderModels(getDb(), id, [{ id: 'disabled' }])
    await updateModel(getDb(), modelId, { enabled: 0 })
    const { result } = await setup()
    act(() => result.current.toggle(id, false))
    expect(result.current.pendingDisable?.id).toBe(id)
    expect(await connections.getProviderConnection(getDb(), id)).toMatchObject({ enabled: 1 })
  })

  it.each(['unused', 'deleted model', 'another account'] as const)(
    'disables without a warning when the only usage is %s',
    async (usage) => {
      const id = await createConnection()
      if (usage === 'deleted model') {
        const [modelId] = await addProviderModels(getDb(), id, [{ id: 'deleted' }])
        await updateModel(getDb(), modelId, { deletedAt: new Date().toISOString() })
      } else if (usage === 'another account') {
        const otherId = await createConnection('Other Otari')
        await addProviderModels(getDb(), otherId, [{ id: 'other' }])
        useSearchProviderStore.getState().selectSearchConnection(otherId)
      }
      const { result } = await setup()
      act(() => result.current.toggle(id, false))
      expect(result.current.pendingDisable).toBeUndefined()
      await settle()
      expect(await connections.getProviderConnection(getDb(), id)).toMatchObject({ enabled: 0 })
      expect(result.current.error).toBeNull()
    },
  )

  it('keeps the optimistic disabled value through the pending write and query refresh without bouncing back', async () => {
    const id = await createConnection()
    const write = connections.updateProviderConnection
    const gate = Promise.withResolvers<void>()
    const update = spyOn(connections, 'updateProviderConnection').mockImplementation(async (...args) => {
      await gate.promise
      await write(...args)
    })
    const observed: number[] = []
    const { result } = renderHook(
      () => {
        const state = useAiProviderConnections()
        const provider = state.providers.find((candidate) => candidate.id === id)
        if (provider) {
          observed.push(provider.enabled)
        }
        return state
      },
      { wrapper: createTestProvider() },
    )
    await settle()
    act(() => result.current.toggle(id, false))
    await settle()
    expect(result.current.pending).toBe(true)
    expect(result.current.providers[0].enabled).toBe(0)
    expect(await connections.getProviderConnection(getDb(), id)).toMatchObject({ enabled: 1 })
    act(() => result.current.toggle(id, true))
    expect(update).toHaveBeenCalledTimes(1)
    expect(result.current.providers[0].enabled).toBe(0)
    await act(async () => {
      gate.resolve()
      await getClock().runAllAsync()
    })
    expect(result.current.pending).toBe(false)
    expect(result.current.providers[0].enabled).toBe(0)
    expect(await connections.getProviderConnection(getDb(), id)).toMatchObject({ enabled: 0 })
    expect(observed.indexOf(0)).toBeGreaterThanOrEqual(0)
    expect(observed.slice(observed.indexOf(0)).every((enabled) => enabled === 0)).toBe(true)
  })

  it('rolls back a failed disable without changing credentials, model toggles, or search selection', async () => {
    const id = await createConnection()
    const [enabledId, disabledId] = await addProviderModels(getDb(), id, [{ id: 'enabled' }, { id: 'disabled' }])
    await updateModel(getDb(), disabledId, { enabled: 0 })
    useSearchProviderStore.getState().selectSearchConnection(id)
    const credentials = await connections.getProviderCredentials(getDb(), id)
    const gate = Promise.withResolvers<void>()
    spyOn(connections, 'updateProviderConnection').mockImplementation(() => gate.promise)
    const { result } = await setup()
    act(() => result.current.toggle(id, false))
    act(() => result.current.confirmDisable())
    await settle()
    expect(result.current.providers[0].enabled).toBe(0)
    expect(result.current.pending).toBe(true)
    await act(async () => {
      gate.reject(new Error('Storage unavailable'))
      await getClock().runAllAsync()
    })
    expect(result.current.pending).toBe(false)
    expect(result.current.error).toBe('Could not update the connection. Try again.')
    expect(result.current.providers[0].enabled).toBe(1)
    expect(await connections.getProviderConnection(getDb(), id)).toMatchObject({ enabled: 1, connected: true })
    expect(await connections.getProviderCredentials(getDb(), id)).toEqual(credentials)
    expect(await getModel(getDb(), enabledId)).toMatchObject({ enabled: 1, deletedAt: null })
    expect(await getModel(getDb(), disabledId)).toMatchObject({ enabled: 0, deletedAt: null })
    expect(useSearchProviderStore.getState()).toMatchObject({ selection: 'connection', connectionId: id })
  })

  it('enables a used account immediately without confirmation and preserves its model preference', async () => {
    const id = await createConnection()
    const [modelId] = await addProviderModels(getDb(), id, [{ id: 'disabled' }])
    await updateModel(getDb(), modelId, { enabled: 0 })
    await connections.updateProviderConnection(getDb(), id, { enabled: false })
    useSearchProviderStore.getState().selectSearchConnection(id)
    const { result } = await setup()
    act(() => result.current.toggle(id, true))
    expect(result.current.pendingDisable).toBeUndefined()
    await settle()
    expect(result.current.providers[0].enabled).toBe(1)
    expect((await connections.getProviderCredentials(getDb(), id))?.apiKey).toBe('device-key')
    expect(await getModel(getDb(), modelId)).toMatchObject({ enabled: 0, deletedAt: null })
  })
})
