/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getDb } from '@/db/database'
import { getAllModels } from '@/dal'
import {
  getProviderConnection,
  getProviderConnections,
  getProviderCredentials,
  saveProviderConnection,
  disconnectProviderConnection,
} from '@/dal/provider-connections'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import { http } from '@/lib/http'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { stubJsonResponse } from '@/test-utils/http'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { ProviderConnectionForm } from './provider-connection-form'

const authorization = {
  authorize: mock(async () => {}),
  cancel: mock(() => {}),
  isPending: false,
  error: null,
  manual: null,
}
const onSaved = mock((_id: string) => {})
const onCancel = mock(() => {})
const settle = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('provider connection form', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    await resetTestDatabase()
    authorization.authorize.mockClear()
    authorization.cancel.mockClear()
    onSaved.mockClear()
    useSearchProviderStore.getState().clearSearchProvider()
  })
  afterEach(() => {
    cleanup()
    mock.restore()
    useSearchProviderStore.getState().clearSearchProvider()
  })

  it('saves a named API-key connection without creating a model, and supports another account for the same service', async () => {
    const first = renderWithReactivity(
      <ProviderConnectionForm provider="openai" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Personal' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: ' first-key ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await settle()
    first.unmount()
    renderWithReactivity(
      <ProviderConnectionForm provider="openai" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'second-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await settle()
    const connections = await getProviderConnections(getDb())
    expect(connections.map((connection) => connection.name)).toEqual(['Personal', 'Work'])
    expect(connections.every((connection) => connection.connected)).toBe(true)
    expect(connections[0].id).not.toBe(connections[1].id)
    expect(await getAllModels(getDb())).toEqual([])
    expect(await getProviderCredentials(getDb(), connections[0].id)).toMatchObject({ apiKey: 'first-key' })
  })

  it('reconnects metadata on this device using the same connection ID', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'anthropic',
      name: 'Team',
      authMethod: 'api_key',
      credentials: { apiKey: 'old-device-key' },
    })
    await disconnectProviderConnection(getDb(), id)
    const connection = await getProviderConnection(getDb(), id)
    renderWithReactivity(
      <ProviderConnectionForm
        provider="anthropic"
        connection={connection!}
        authorization={authorization}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByLabelText('API key')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-device-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await settle()
    expect(onSaved).toHaveBeenCalledWith(id)
    expect(await getProviderConnections(getDb())).toHaveLength(1)
    expect(await getProviderCredentials(getDb(), id)).toMatchObject({ apiKey: 'new-device-key' })
  })

  it('uses official Otari defaults and only shows a URL field after choosing a custom URL', async () => {
    renderWithReactivity(
      <ProviderConnectionForm provider="otari" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Custom URL' }))
    expect(screen.getByLabelText('Server URL')).toHaveFocus()
    expect(screen.getByLabelText('Server URL')).toHaveAttribute('placeholder', 'http://localhost:8099')
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://otari.example/api/v1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect Otari' }))
    expect(authorization.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'otari', name: 'Otari', url: 'https://otari.example/api/v1' }),
    )
  })

  it.each(['none', 'cloud', 'connection'] as const)(
    'discovers API-key Otari search at the normalized endpoint without replacing the %s search choice',
    async (selection) => {
      const otherConnectionId = await saveProviderConnection(getDb(), {
        provider: 'exa',
        name: 'Existing search',
        authMethod: 'api_key',
        credentials: { apiKey: 'search-key' },
      })
      if (selection === 'connection') {
        useSearchProviderStore.getState().selectSearchConnection(otherConnectionId)
      } else {
        useSearchProviderStore.getState().selectSearchProvider(selection)
      }
      const get = spyOn(http, 'get').mockReturnValue(
        stubJsonResponse({ data: [{ id: 'otari_web_search', direct_available: true }] }),
      )
      renderWithReactivity(
        <ProviderConnectionForm provider="otari" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
      )
      fireEvent.click(screen.getByRole('radio', { name: 'API key' }))
      fireEvent.click(screen.getByRole('button', { name: 'Custom URL' }))
      fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'http://localhost:8099' } })
      fireEvent.change(screen.getByLabelText('API key', { selector: 'input[type="password"]' }), {
        target: { value: ' local-key ' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
      await settle()

      const connection = (await getProviderConnections(getDb())).find((item) => item.provider === 'otari')!
      expect(connection.url).toBe('http://localhost:8099/api/v1')
      expect(get).toHaveBeenCalledWith(
        'http://localhost:8099/api/v1/tools',
        expect.objectContaining({
          headers: { Authorization: 'Bearer local-key' },
          credentials: 'omit',
          redirect: 'error',
        }),
      )
      expect(useSearchProviderStore.getState()).toMatchObject({
        selection,
        connectionId: selection === 'connection' ? otherConnectionId : null,
        connectionStatus: { connectionId: connection.id, status: 'available' },
      })
      expect(onSaved).toHaveBeenCalledWith(connection.id)
    },
  )

  it('aborts Otari discovery on unmount and ignores a late response', async () => {
    useSearchProviderStore.getState().selectSearchProvider('none')
    const discoveryStarted = Promise.withResolvers<void>()
    const discoveryResponse = Promise.withResolvers<unknown>()
    const response = stubJsonResponse(null)
    response.json = <T,>() => discoveryResponse.promise as Promise<T>
    const get = spyOn(http, 'get').mockImplementation(() => {
      discoveryStarted.resolve()
      return response
    })
    const view = renderWithReactivity(
      <ProviderConnectionForm provider="otari" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'API key' }))
    fireEvent.change(screen.getByLabelText('API key', { selector: 'input[type="password"]' }), {
      target: { value: 'local-key' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await act(async () => {
      await discoveryStarted.promise
    })
    view.unmount()
    expect(get.mock.calls[0][1]?.signal?.aborted).toBe(true)
    discoveryResponse.resolve({ data: [{ id: 'otari_web_search', direct_available: true }] })
    await settle()

    expect(onSaved).not.toHaveBeenCalled()
    expect(useSearchProviderStore.getState()).toMatchObject({
      selection: 'none',
      connectionId: null,
      connectionStatus: null,
    })
  })

  it('allows an unauthenticated compatible endpoint but requires a server URL', async () => {
    renderWithReactivity(
      <ProviderConnectionForm provider="custom" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'http://localhost:11434/v1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await settle()
    expect((await getProviderConnections(getDb()))[0]).toMatchObject({ provider: 'custom', connected: true })
  })

  it('keeps an in-progress sign-in cancelable on hover', () => {
    renderWithReactivity(
      <ProviderConnectionForm
        provider="otari"
        authorization={{ ...authorization, isPending: true }}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    )
    const button = screen.getByRole('button', { name: 'Cancel connection' })
    expect(button).toHaveTextContent('Connecting…')
    fireEvent.mouseEnter(button)
    expect(button).toHaveTextContent('Cancel')
    fireEvent.click(button)
    expect(authorization.cancel).toHaveBeenCalledTimes(1)
  })

  it('opens an existing OAuth account instead of renaming it or creating another sign-in connection', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openrouter',
      name: 'My account',
      authMethod: 'oauth',
      credentials: { access_token: 'oauth-key' },
    })
    const existingOAuth = await getProviderConnection(getDb(), id)
    renderWithReactivity(
      <ProviderConnectionForm
        provider="openrouter"
        existingOAuth={existingOAuth!}
        authorization={authorization}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    )
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open My account' }))
    expect(onSaved).toHaveBeenCalledWith(id)
    expect(authorization.authorize).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'API key' }))
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled()
  })
})
