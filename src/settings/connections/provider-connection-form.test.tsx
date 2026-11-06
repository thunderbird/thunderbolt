/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getDb } from '@/db/database'
import { eq } from 'drizzle-orm'
import { providerConnectionsTable } from '@/db/tables'
import * as providerConnections from '@/dal/provider-connections'
import { getAllModels } from '@/dal'
import {
  getProviderConnection,
  getProviderConnections,
  getProviderCredentials,
  saveProviderConnection,
  saveProviderConnectionInTransaction,
  disconnectProviderConnection,
} from '@/dal/provider-connections'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import { http } from '@/lib/http'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { stubJsonResponse } from '@/test-utils/http'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
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
    await getClock().tickAsync(10)
  })
  await waitForElement(() =>
    screen.queryByRole('button', { name: /^(Save connection|Save Changes)$/ })?.getAttribute('aria-busy') === 'true'
      ? null
      : document.body,
  )
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

  it.each([
    { provider: 'openai', authMethod: 'api_key' },
    { provider: 'openrouter', authMethod: 'oauth' },
    { provider: 'otari', authMethod: 'oauth' },
  ] as const)(
    'renames $provider without replacing credentials or signing in again',
    async ({ provider, authMethod }) => {
      const credentials =
        authMethod === 'oauth'
          ? { access_token: 'private-token', refresh_token: 'private-refresh' }
          : { apiKey: 'private-key' }
      const id = await saveProviderConnection(getDb(), {
        provider,
        name: 'Work',
        authMethod,
        credentials,
      })
      const connection = (await getProviderConnection(getDb(), id))!
      const get = spyOn(http, 'get')
      renderWithReactivity(
        <ProviderConnectionForm
          mode="edit"
          provider={provider}
          connection={connection}
          authorization={authorization}
          onSaved={onSaved}
          onCancel={onCancel}
        />,
      )
      expect(screen.queryByRole('button', { name: 'Use API Key instead' })).toBeNull()
      if (authMethod === 'oauth') {
        expect(screen.queryByLabelText('API key')).toBeNull()
        expect(screen.queryByLabelText('Server URL')).toBeNull()
      } else {
        const key = screen.getByLabelText('API key')
        expect(key).toHaveValue('')
        expect(key).toHaveAttribute('type', 'password')
        expect(key).toHaveAttribute('placeholder', '********')
        expect(key).toBeEnabled()
      }
      expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Research  ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
      await settle()
      expect(onSaved).toHaveBeenCalledWith(id)
      expect(await getProviderConnection(getDb(), id)).toMatchObject({ name: 'Research', authMethod, connected: true })
      expect(await getProviderCredentials(getDb(), id)).toMatchObject(credentials)
      expect(authorization.authorize).not.toHaveBeenCalled()
      expect(get).not.toHaveBeenCalled()
    },
  )

  it('saves an updated name and API key together on the same connection', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Work',
      authMethod: 'api_key',
      credentials: { apiKey: 'old-key' },
    })
    renderWithReactivity(
      <ProviderConnectionForm
        mode="edit"
        provider="openai"
        connection={(await getProviderConnection(getDb(), id))!}
        authorization={authorization}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    )
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Personal' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: ' new-key ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await settle()
    expect(await getProviderConnections(getDb())).toHaveLength(1)
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ name: 'Personal', connected: true })
    expect(await getProviderCredentials(getDb(), id)).toMatchObject({ apiKey: 'new-key' })
    expect(onSaved).toHaveBeenCalledWith(id)
  })

  it('requires a new API key when changing an Otari server URL and never sends the saved key there', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'otari',
      name: 'Work',
      url: 'https://old.example/api/v1',
      authMethod: 'api_key',
      credentials: { apiKey: 'private-old-key' },
    })
    const get = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [] }))
    renderWithReactivity(
      <ProviderConnectionForm
        mode="edit"
        provider="otari"
        connection={(await getProviderConnection(getDb(), id))!}
        authorization={authorization}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    )
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://new.example' } })
    expect(screen.getByLabelText('API key')).not.toHaveAttribute('placeholder')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
    expect(get).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-server-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await settle()
    expect(get).toHaveBeenCalledWith(
      'https://new.example/api/v1/tools',
      expect.objectContaining({
        headers: { Authorization: 'Bearer new-server-key' },
      }),
    )
    expect(await getProviderCredentials(getDb(), id)).toMatchObject({ apiKey: 'new-server-key' })
    expect(onSaved).toHaveBeenCalledWith(id)
  })

  it('can switch a compatible connection to an anonymous server without carrying its old key', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'custom',
      name: 'Local',
      url: 'http://localhost:1234/v1',
      authMethod: 'api_key',
      credentials: { apiKey: 'private-old-key' },
    })
    renderWithReactivity(
      <ProviderConnectionForm
        mode="edit"
        provider="custom"
        connection={(await getProviderConnection(getDb(), id))!}
        authorization={authorization}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    )
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'http://localhost:5678/v1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await settle()
    expect(await getProviderCredentials(getDb(), id)).toMatchObject({ apiKey: '' })
    expect(onSaved).toHaveBeenCalledWith(id)
  })

  it('keeps failed edits available for retry without changing the saved credentials', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'openai',
      name: 'Work',
      authMethod: 'api_key',
      credentials: { apiKey: 'private-key' },
    })
    const update = spyOn(providerConnections, 'updateProviderConnection').mockRejectedValueOnce(
      new Error('Unavailable'),
    )
    renderWithReactivity(
      <ProviderConnectionForm
        mode="edit"
        provider="openai"
        connection={(await getProviderConnection(getDb(), id))!}
        authorization={authorization}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    )
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Personal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await settle()
    expect(await waitForElement(() => screen.queryByRole('alert'))).toHaveTextContent('Could not save the connection')
    expect(screen.getByLabelText('Name')).toHaveValue('Personal')
    expect(onSaved).not.toHaveBeenCalled()
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ name: 'Work' })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await settle()
    expect(update).toHaveBeenCalledTimes(2)
    expect(onSaved).toHaveBeenCalledWith(id)
    expect(await getProviderCredentials(getDb(), id)).toMatchObject({ apiKey: 'private-key' })
  })

  it('uses official Otari defaults and only shows a URL field after choosing a custom URL', async () => {
    renderWithReactivity(
      <ProviderConnectionForm provider="otari" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    expect(screen.queryByLabelText('Name')).toBeNull()
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

  it.each(['otari', 'tinfoil', 'openrouter'] as const)(
    'switches %s authentication through the secondary link without submitting or losing the name',
    (provider) => {
      renderWithReactivity(
        <ProviderConnectionForm
          provider={provider}
          authorization={authorization}
          onSaved={onSaved}
          onCancel={onCancel}
        />,
      )
      expect(screen.queryByRole('radio')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Name')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My account' } })
      expect(screen.getByLabelText('API key')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled()
      fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-key' } })
      expect(screen.getByRole('button', { name: 'Save connection' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Use sign-in instead' }))
      expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Name')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
      expect(screen.getByLabelText('Name')).toHaveValue('My account')
      expect(authorization.authorize).not.toHaveBeenCalled()
      expect(onSaved).not.toHaveBeenCalled()
      expect(authorization.cancel).toHaveBeenCalledTimes(3)
    },
  )

  it.each(['none', 'cloud', 'connection'] as const)(
    'discovers API-key Otari search at the normalized endpoint without replacing the %s search choice',
    async (selection) => {
      const saved = Promise.withResolvers<void>()
      onSaved.mockImplementationOnce(() => saved.resolve())
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
      fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
      fireEvent.click(screen.getByRole('button', { name: 'Custom URL' }))
      fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'http://localhost:8099' } })
      fireEvent.change(screen.getByLabelText('API key', { selector: 'input[type="password"]' }), {
        target: { value: ' local-key ' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
      await act(async () => saved.promise)

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
    fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
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

  it('never sends a saved key to a server URL changed by sync before discovery', async () => {
    const save = providerConnections.saveProviderConnectionWithRevision
    spyOn(providerConnections, 'saveProviderConnectionWithRevision').mockImplementation(async (...args) => {
      const saved = await save(...args)
      await getDb()
        .update(providerConnectionsTable)
        .set({ url: 'https://unapproved.example/api/v1' })
        .where(eq(providerConnectionsTable.id, saved.id))
      return saved
    })
    const get = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [] }))
    renderWithReactivity(
      <ProviderConnectionForm provider="otari" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'private-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await settle()
    expect(get).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save the connection. Try again.')
  })

  it('does not overwrite newer search capabilities with an earlier account discovery', async () => {
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<unknown>()
    const request = stubJsonResponse(null)
    request.json = <T,>() => response.promise as Promise<T>
    spyOn(http, 'get').mockImplementation(() => {
      started.resolve()
      return request
    })
    renderWithReactivity(
      <ProviderConnectionForm provider="otari" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'old-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await act(async () => started.promise)
    const connection = (await getProviderConnections(getDb()))[0]
    await saveProviderConnection(getDb(), {
      id: connection.id,
      provider: 'otari',
      name: 'New account',
      url: connection.url,
      authMethod: 'api_key',
      credentials: { apiKey: 'new-key' },
    })
    useSearchProviderStore.getState().configureProviderSearch(connection.id, 'not_configured', { select: false })
    response.resolve({ data: [{ id: 'otari_web_search', direct_available: true }] })
    await settle()
    expect(useSearchProviderStore.getState().connectionStatus?.status).toBe('not_configured')
    expect((await getProviderCredentials(getDb(), connection.id))?.apiKey).toBe('new-key')
    expect(onSaved).not.toHaveBeenCalled()
    expect(await waitForElement(() => screen.queryByRole('alert'))).toHaveTextContent('Could not save the connection')
  })

  it.each(['openai', 'tinfoil'] as const)(
    'does not announce a saved %s connection that was disconnected before its save returned',
    async (provider) => {
      const save = providerConnections.saveProviderConnectionWithRevision
      spyOn(providerConnections, 'saveProviderConnectionWithRevision').mockImplementation(async (...args) => {
        const saved = await save(...args)
        await disconnectProviderConnection(getDb(), saved.id)
        return saved
      })
      renderWithReactivity(
        <ProviderConnectionForm
          provider={provider}
          authorization={authorization}
          onSaved={onSaved}
          onCancel={onCancel}
        />,
      )
      if (provider === 'tinfoil') {
        fireEvent.click(screen.getByRole('button', { name: 'Use API Key instead' }))
      }
      fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'key' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
      await settle()
      expect(onSaved).not.toHaveBeenCalled()
      expect(useSearchProviderStore.getState().connectionStatus).toBeNull()
      expect(await waitForElement(() => screen.queryByRole('alert'))).toHaveTextContent('Could not save the connection')
    },
  )

  it('updates a disabled Otari account without using its credentials for discovery', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'otari',
      name: 'Disabled',
      url: 'https://otari.example/api/v1',
      authMethod: 'api_key',
      credentials: { apiKey: 'old' },
      enabled: false,
    })
    const connection = (await getProviderConnection(getDb(), id))!
    const get = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [] }))
    renderWithReactivity(
      <ProviderConnectionForm
        provider="otari"
        connection={connection}
        authorization={authorization}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    )
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    await settle()
    expect(get).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledWith(id)
    expect(await getProviderConnection(getDb(), id)).toMatchObject({ enabled: 0, connected: true })
  })

  it('does not persist an API-key submission when its form immediately unmounts', async () => {
    const view = renderWithReactivity(
      <ProviderConnectionForm provider="openai" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'cancelled-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
    view.unmount()
    await settle()
    expect(await getProviderConnections(getDb())).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('deduplicates immediate submissions and allows retry after a failed write', async () => {
    const save = spyOn(providerConnections, 'saveProviderConnectionWithRevision').mockRejectedValueOnce(
      new Error('Unavailable'),
    )
    renderWithReactivity(
      <ProviderConnectionForm provider="openai" authorization={authorization} onSaved={onSaved} onCancel={onCancel} />,
    )
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'key' } })
    const form = screen.getByRole('button', { name: 'Save connection' }).closest('form')!
    act(() => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
    expect(await waitForElement(() => screen.queryByRole('alert'))).toHaveTextContent('Could not save the connection')
    fireEvent.submit(form)
    await settle()
    expect(save).toHaveBeenCalledTimes(2)
    expect(await getProviderConnections(getDb())).toHaveLength(1)
    expect(onSaved).toHaveBeenCalledTimes(1)
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
    expect(screen.getByRole('button', { name: 'Use API Key instead' })).toBeDisabled()
    expect(button).toHaveTextContent('Connecting…')
    fireEvent.mouseEnter(button)
    expect(button).toHaveTextContent('Cancel')
    fireEvent.click(button)
    expect(authorization.cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['otari', 'tinfoil', 'openrouter'] as const)(
    'shows an existing %s sign-in clearly and offers only a secondary API-key connection',
    async (provider) => {
      const id = await getDb().transaction((tx) =>
        saveProviderConnectionInTransaction(tx, {
          provider,
          name: 'My account',
          authMethod: 'oauth',
          credentials: { access_token: 'oauth-key', refresh_token: 'refresh-key' },
        }),
      )
      renderWithReactivity(
        <ProviderConnectionForm
          provider={provider}
          existingOAuth={(await getProviderConnection(getDb(), id))!}
          authorization={authorization}
          onSaved={onSaved}
          onCancel={onCancel}
        />,
      )
      expect(screen.getByRole('status')).toHaveTextContent(/Connected to/)
      expect(screen.getByRole('status')).not.toHaveTextContent('My account')
      expect(screen.queryByLabelText('Name')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open My account' })).toBeNull()
      expect(screen.queryByRole('button', { name: /Connect / })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
      expect(screen.getByRole('status').closest('form')).toBeNull()
      expect(onSaved).not.toHaveBeenCalled()
      expect(authorization.authorize).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Add another instance via API key' }))
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.getByLabelText('Name')).toBeInTheDocument()
      expect(screen.getByLabelText('API key')).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Save connection' })).toBeDisabled()
    },
  )

  it('reconnects a saved OAuth account on this device using its existing name and server', async () => {
    const id = await saveProviderConnection(getDb(), {
      provider: 'otari',
      name: 'Team Otari',
      url: 'https://team.example/api/v1',
      authMethod: 'oauth',
      credentials: { access_token: 'old-key' },
    })
    await disconnectProviderConnection(getDb(), id)
    renderWithReactivity(
      <ProviderConnectionForm
        provider="otari"
        existingOAuth={(await getProviderConnection(getDb(), id))!}
        authorization={authorization}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Sign in to reconnect Otari on this device.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Otari' }))
    expect(authorization.authorize).toHaveBeenCalledWith({
      provider: 'otari',
      name: 'Team Otari',
      url: 'https://team.example/api/v1',
      id,
    })
    expect(onSaved).not.toHaveBeenCalled()
  })
})
