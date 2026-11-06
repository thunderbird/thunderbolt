/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, renderHook, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getDb } from '@/db/database'
import { modelsSecretsTable } from '@/db/tables'
import { getAllModels, updateModel } from '@/dal'
import { saveProviderConnection, updateProviderConnection } from '@/dal/provider-connections'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import * as providerModels from '@/providers/models'
import { getClock } from '@/testing-library'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createTestProvider } from '@/test-utils/test-provider'
import { AddProviderModels } from './add-provider-models'
import { useAddProviderModels } from './use-add-provider-models'

const saved = mock(() => {})
const Picker = () => <AddProviderModels {...useAddProviderModels({ isOpen: true, onClose: saved })} />
const renderPicker = () =>
  renderWithReactivity(<Picker />, {
    route: '/settings/models',
    tables: ['provider_connections', 'provider_connection_secrets', 'models'],
  })
const settle = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}
const chooseConnection = async (name: string) => {
  fireEvent.click(await waitForElement(() => screen.queryByRole('combobox', { name: 'Connection' })))
  fireEvent.click(await waitForElement(() => screen.queryByRole('option', { name: new RegExp(name) })))
  await settle()
}

describe('connection model picker', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    await resetTestDatabase()
    saved.mockClear()
  })
  afterEach(() => {
    cleanup()
    mock.restore()
  })

  it('searches a catalog, keeps selections across searches, and adds several models without duplicating credentials', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Personal account',
      authMethod: 'api_key',
      credentials: { apiKey: 'device-secret' },
    })
    spyOn(providerModels, 'fetchProviderModels').mockResolvedValue([
      { id: 'one', name: 'First model' },
      { id: 'two', name: 'Second model' },
    ])
    renderPicker()
    await chooseConnection('Personal account')
    fireEvent.click(await waitForElement(() => screen.queryByRole('checkbox', { name: 'First model' })))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'two' } })
    await settle()
    expect(screen.queryByRole('checkbox', { name: 'First model' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Second model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add models' }))
    await settle()
    const models = await getAllModels(getDb())
    expect(models.map((model) => model.model).sort()).toEqual(['one', 'two'])
    expect(models.every((model) => model.providerConnectionId === id)).toBe(true)
    expect(await getDb().select().from(modelsSecretsTable)).toEqual([])
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it('marks an existing disabled model as added without changing its preferences', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Existing',
      authMethod: 'api_key',
      credentials: { apiKey: 'key' },
    })
    const [modelId] = await providerModels.addProviderModels(getDb(), id, [{ id: 'one', name: 'Original' }])
    await updateModel(getDb(), modelId, { enabled: 0, name: 'My name', toolUsage: 0 })
    spyOn(providerModels, 'fetchProviderModels').mockResolvedValue([{ id: 'one', name: 'Catalog name' }])
    renderPicker()
    await chooseConnection('Existing')
    const checkbox = await waitForElement(() => screen.queryByRole('checkbox', { name: 'Catalog name' }))
    expect(checkbox).toBeChecked()
    expect(checkbox).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add models' })).toBeDisabled()
    expect((await getAllModels(getDb()))[0]).toMatchObject({ enabled: 0, name: 'My name', toolUsage: 0 })
  })

  it('clears selected models when switching connections and never fetches a disabled connection', async () => {
    await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'First',
      authMethod: 'api_key',
      credentials: { apiKey: 'one' },
    })
    const disabled = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Disabled',
      authMethod: 'api_key',
      credentials: { apiKey: 'two' },
    })
    await updateProviderConnection(getDb(), disabled, { enabled: false })
    const fetch = spyOn(providerModels, 'fetchProviderModels').mockResolvedValue([{ id: 'model', name: 'A model' }])
    renderPicker()
    await chooseConnection('First')
    fireEvent.click(await waitForElement(() => screen.queryByRole('checkbox', { name: 'A model' })))
    await chooseConnection('Disabled')
    expect(screen.getByRole('button', { name: 'Add models' })).toBeDisabled()
    expect(screen.getByText('Enable this connection to add models.')).toBeInTheDocument()
    expect(fetch.mock.calls.some((call) => call[1] === disabled)).toBe(false)
    await chooseConnection('First')
    expect(await waitForElement(() => screen.queryByRole('checkbox', { name: 'A model' }))).not.toBeChecked()
  })

  it('allows a manual custom model when discovery fails and keeps retry available', async () => {
    await saveProviderConnection(getDb(), {
      provider: 'custom',
      name: 'Local server',
      authMethod: 'api_key',
      url: 'http://localhost:11434/v1',
      credentials: {},
    })
    const fetch = spyOn(providerModels, 'fetchProviderModels').mockRejectedValue(new Error('No catalog'))
    renderPicker()
    await chooseConnection('Local server')
    expect(await waitForElement(() => screen.queryByRole('alert'))).toHaveTextContent('Could not load')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Enter a model ID' }))
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: '  local-model  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add models' }))
    await settle()
    expect((await getAllModels(getDb()))[0]?.model).toBe('local-model')
  })

  it.each(['cancel', 'unmount', 'switch'] as const)('does not save queued selections after %s', async (action) => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Account',
      authMethod: 'api_key',
      credentials: { apiKey: 'key' },
    })
    spyOn(providerModels, 'fetchProviderModels').mockResolvedValue([{ id: 'model' }])
    const started = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const addModels = providerModels.addProviderModels
    spyOn(providerModels, 'addProviderModels').mockImplementationOnce(async (...args) => {
      started.resolve()
      await proceed.promise
      return addModels(...args)
    })
    const { result, unmount } = renderHook(() => useAddProviderModels({ isOpen: true, onClose: saved }), {
      wrapper: createTestProvider(),
    })
    await settle()
    act(() => result.current.changeConnection(id))
    await settle()
    act(() => result.current.toggleModel('model'))
    act(() => result.current.submit())
    await started.promise
    if (action === 'unmount') {
      unmount()
    } else if (action === 'cancel') {
      act(() => result.current.onCancel())
    } else {
      act(() => result.current.changeConnection('another-account'))
    }
    proceed.resolve()
    await settle()
    expect(await getAllModels(getDb())).toEqual([])
    expect(saved).toHaveBeenCalledTimes(action === 'cancel' ? 1 : 0)
    if (action === 'switch') {
      expect(result.current.connectionId).toBe('another-account')
    }
  })

  it('blocks adding a hidden stale selection while refreshing or after a failed refresh', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Account',
      authMethod: 'api_key',
      credentials: { apiKey: 'key' },
    })
    const fetch = spyOn(providerModels, 'fetchProviderModels').mockResolvedValue([{ id: 'model' }])
    const { result } = renderHook(() => useAddProviderModels({ isOpen: true, onClose: saved }), {
      wrapper: createTestProvider(),
    })
    await settle()
    act(() => result.current.changeConnection(id))
    await settle()
    act(() => result.current.toggleModel('model'))
    expect(result.current.canSubmit).toBe(true)
    const refresh = Promise.withResolvers<never>()
    fetch.mockImplementationOnce(() => refresh.promise)
    act(() => result.current.refresh())
    await settle()
    expect(result.current.isLoadingCatalog).toBe(true)
    expect(result.current.canSubmit).toBe(false)
    refresh.reject(new Error('Network unavailable'))
    await settle()
    expect(result.current.catalogError).toBeTruthy()
    expect(result.current.canSubmit).toBe(false)
    act(() => result.current.submit())
    await settle()
    expect(await getAllModels(getDb())).toEqual([])
  })
})
