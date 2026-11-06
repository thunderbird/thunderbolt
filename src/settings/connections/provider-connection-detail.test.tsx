/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getProviderConnection, saveProviderConnection, disconnectProviderConnection } from '@/dal/provider-connections'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { http } from '@/lib/http'
import { getProviderDefinition } from '@/providers/registry'
import type { ProviderConnection } from '@/providers/types'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { stubJsonResponse } from '@/test-utils/http'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { ProviderConnectionDetail } from './provider-connection-detail'
import type { useAiProviderConnections } from './use-ai-provider-connections'

const controls: ReturnType<typeof useAiProviderConnections> = {
  providers: [],
  ready: true,
  pending: false,
  error: null,
  toggle: () => {},
  pendingDisable: undefined,
  cancelDisable: () => {},
  confirmDisable: () => {},
  disconnect: () => {},
  remove: () => {},
}
const authorization = { authorize: async () => {}, cancel: () => {}, isPending: false, error: null, manual: null }
const connection: ProviderConnection = {
  id: 'test-connection',
  provider: 'openrouter',
  name: 'OpenRouter',
  url: null,
  authMethod: 'oauth',
  enabled: 1,
  connected: true,
  createdAt: '',
  updatedAt: '',
  deletedAt: null,
  userId: null,
}

/** Opens the same header actions menu used by model and MCP details. */
const selectAction = async (name: string) => {
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
  })
  fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name })))
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('provider connection detail', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    await resetTestDatabase()
    useSearchProviderStore.getState().clearSearchProvider()
  })
  afterEach(() => {
    cleanup()
    mock.restore()
    useSearchProviderStore.getState().clearSearchProvider()
  })

  it.each(['oauth', 'api_key'] as const)(
    'shows read-only details with visible connection actions: %s',
    (authMethod) => {
      const disconnect = mock(() => {})
      renderWithReactivity(
        <ProviderConnectionDetail
          connection={{ ...connection, provider: 'otari', authMethod }}
          controls={{ ...controls, disconnect }}
          authorization={authorization}
          onClose={() => {}}
        />,
        { route: '/settings/connections' },
      )

      expect(screen.queryByRole('heading', { name: 'Status' })).toBeNull()
      expect(screen.queryByText('Connected')).toBeNull()
      expect(screen.queryByRole('link', { name: 'Search settings' })).toBeNull()
      expect(screen.getByRole('button', { name: 'More' })).toBeVisible()
      expect(screen.queryByLabelText('Name')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Update credentials' })).toBeNull()
      expect(screen.queryByRole('link', { name: 'Manage models' })).toBeNull()
      expect(screen.queryByText('Disconnecting keeps your models and connection settings.')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect this device' }))
      expect(disconnect).toHaveBeenCalledWith(connection.id)
    },
  )

  it.each([true, false])('offers removal with confirmation when connected is %s', async (connected) => {
    const remove = mock(() => {})
    const onClose = mock(() => {})
    renderWithReactivity(
      <ProviderConnectionDetail
        connection={{ ...connection, connected }}
        controls={{ ...controls, remove }}
        authorization={authorization}
        onClose={onClose}
      />,
      { route: '/settings/connections' },
    )
    await selectAction('Remove connection')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Your chat history will be kept.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(remove).not.toHaveBeenCalled()
    await selectAction('Remove connection')
    fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }))
    expect(remove).toHaveBeenCalledWith(connection.id, onClose)
  })

  it.each(['oauth', 'api_key'] as const)(
    'keeps removal available while editing a %s connection',
    async (authMethod) => {
      const remove = mock(() => {})
      renderWithReactivity(
        <ProviderConnectionDetail
          connection={{ ...connection, authMethod }}
          initialAction="edit"
          controls={{ ...controls, remove }}
          authorization={authorization}
          onClose={() => {}}
        />,
        { route: '/settings/connections' },
      )
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved name' } })
      await selectAction('Remove connection')
      expect(screen.getByRole('alertdialog')).toHaveTextContent('Remove OpenRouter?')
      expect(remove).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
      expect(screen.getByLabelText('Name')).toHaveValue('Unsaved name')
      expect(screen.getByRole('button', { name: 'More' })).toBeVisible()
    },
  )

  it('keeps a signed-in ChatGPT account manageable until plan access is granted', async () => {
    const authorize = mock(async () => {})
    const disconnect = mock(() => {})
    const addApiKey = mock(() => {})
    renderWithReactivity(
      <ProviderConnectionDetail
        connection={{
          ...connection,
          id: 'oauth:openai',
          provider: 'openai',
          name: 'ChatGPT',
          connected: false,
          needsConsent: true,
        }}
        controls={{ ...controls, disconnect }}
        authorization={{ ...authorization, authorize }}
        onAddApiKey={addApiKey}
        onBack={() => {}}
        onClose={() => {}}
      />,
      { route: '/settings/connections' },
    )
    expect(screen.getByRole('status')).toHaveTextContent('Signed in to ChatGPT')
    expect(screen.getByRole('status')).toHaveTextContent('Allow access to your ChatGPT plan')
    expect(screen.queryByText('Connected to ChatGPT')).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow plan access' }))
    expect(authorize).toHaveBeenCalledWith({ provider: 'openai', id: 'oauth:openai', name: 'ChatGPT' })
    fireEvent.click(screen.getByRole('button', { name: 'Add another instance via API key' }))
    expect(addApiKey).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect this device' }))
    expect(disconnect).toHaveBeenCalledWith('oauth:openai')
    await selectAction('Edit')
    expect(screen.getByLabelText('Name')).toHaveValue('ChatGPT')
    expect(screen.queryByLabelText('API key')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Allow plan access' })).toBeVisible()
  })

  it('offers a separate API-key connection when this browser cannot reconnect a saved ChatGPT account', () => {
    const addApiKey = mock(() => {})
    renderWithReactivity(
      <ProviderConnectionDetail
        connection={{ ...connection, provider: 'openai', name: 'ChatGPT', connected: false }}
        controls={controls}
        authorization={authorization}
        onAddApiKey={addApiKey}
        onClose={() => {}}
      />,
      { route: '/settings/connections' },
    )
    expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add another instance via API key' }))
    expect(addApiKey).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('API key')).toBeNull()
  })

  it('allows canceling a plan-permission retry and displays its error without losing the account', () => {
    const cancel = mock(() => {})
    const detail = (isPending: boolean, error: string | null = null) => (
      <ProviderConnectionDetail
        connection={{ ...connection, provider: 'openai', name: 'ChatGPT', connected: false, needsConsent: true }}
        controls={controls}
        authorization={{ ...authorization, isPending, cancel, error }}
        onClose={() => {}}
      />
    )
    const view = renderWithReactivity(detail(true), { route: '/settings/connections' })
    expect(screen.getByRole('button', { name: 'Disconnect this device' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    view.rerender(detail(false, 'Please try again.'))
    expect(screen.getByRole('alert')).toHaveTextContent('Please try again.')
    expect(screen.getByRole('button', { name: 'Allow plan access' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('Signed in to ChatGPT')
  })

  it('omits the official Otari URL from the OAuth notice', () => {
    renderWithReactivity(
      <ProviderConnectionDetail
        connection={{ ...connection, provider: 'otari', url: getProviderDefinition('otari').defaultUrl! }}
        controls={controls}
        authorization={authorization}
        onClose={() => {}}
      />,
      { route: '/settings/connections' },
    )
    expect(screen.getByRole('status')).toHaveTextContent('Connected to Otari')
    expect(screen.queryByText(getProviderDefinition('otari').defaultUrl!)).toBeNull()
  })

  it('edits the latest name with locked OAuth credentials and discards canceled changes', async () => {
    const detail = (name: string) => (
      <ProviderConnectionDetail
        connection={{ ...connection, name }}
        controls={controls}
        authorization={authorization}
        onClose={() => {}}
      />
    )
    const view = renderWithReactivity(detail('OpenRouter'), { route: '/settings/connections' })
    view.rerender(detail('Work account'))
    await selectAction('Edit')
    expect(screen.getByLabelText('Name')).toHaveValue('Work account')
    expect(screen.getByLabelText('Name')).toHaveFocus()
    expect(screen.queryByLabelText('API key')).toBeNull()
    expect(screen.queryByLabelText('Server URL')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Discard me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Name')).toBeNull()
    await selectAction('Edit')
    expect(screen.getByLabelText('Name')).toHaveValue('Work account')
  })

  it('opens a single edit form for the name and API key, and returns to details on cancel', async () => {
    renderWithReactivity(
      <ProviderConnectionDetail
        connection={{ ...connection, authMethod: 'api_key' }}
        controls={controls}
        authorization={authorization}
        onClose={() => {}}
      />,
      { route: '/settings/connections' },
    )
    await selectAction('Edit')
    expect(screen.getByLabelText('Name')).toHaveValue('OpenRouter')
    expect(screen.getByLabelText('API key')).toHaveValue('')
    expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', '********')
    expect(screen.getByLabelText('API key')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'More' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('API key')).toBeNull()
    expect(screen.getByRole('button', { name: 'Disconnect this device' })).toBeVisible()
  })

  it('shows the server URL without status or settings links for a disabled search-only connection', () => {
    renderWithReactivity(
      <ProviderConnectionDetail
        connection={{ ...connection, provider: 'exa', authMethod: 'api_key', enabled: 0, url: 'https://exa.example' }}
        controls={{ ...controls, pending: true }}
        authorization={authorization}
        onClose={() => {}}
      />,
      { route: '/settings/connections' },
    )
    expect(screen.queryByText('Connection disabled')).toBeNull()
    expect(screen.getByText('https://exa.example')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Disconnect this device' })).toBeDisabled()
    expect(screen.queryByRole('link', { name: 'Manage models' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Search settings' })).toBeNull()
  })

  it.each(['initially disconnected', 'disconnected while open'] as const)(
    'finishes reconnect discovery when live metadata becomes connected: %s',
    async (scenario) => {
      const id = await saveProviderConnection(getDb(), {
        provider: 'otari',
        name: 'Workspace',
        authMethod: 'api_key',
        credentials: { apiKey: 'old-key' },
      })
      const connected = (await getProviderConnection(getDb(), id))!
      await disconnectProviderConnection(getDb(), id)
      const disconnected = (await getProviderConnection(getDb(), id))!
      const detail = (connection: typeof connected) => (
        <ProviderConnectionDetail
          connection={connection}
          controls={controls}
          authorization={authorization}
          onClose={() => {}}
        />
      )
      const view = renderWithReactivity(detail(scenario === 'initially disconnected' ? disconnected : connected), {
        route: '/settings/connections',
      })
      if (scenario === 'disconnected while open') {
        view.rerender(detail(disconnected))
      }
      const started = Promise.withResolvers<void>()
      const response = Promise.withResolvers<unknown>()
      const request = stubJsonResponse(null)
      request.json = <T,>() => response.promise as Promise<T>
      const get = spyOn(http, 'get').mockImplementation(() => {
        started.resolve()
        return request
      })
      fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-key' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save connection' }))
      await act(async () => started.promise)

      // PowerSync can publish the committed credentials before discovery completes.
      view.rerender(detail((await getProviderConnection(getDb(), id))!))
      expect(get.mock.calls[0][1]?.signal?.aborted).toBe(false)
      await act(async () => {
        response.resolve({ data: [{ id: 'otari_web_search', direct_available: true }] })
        await getClock().runAllAsync()
      })

      expect(await waitForElement(() => screen.queryByRole('button', { name: 'Disconnect this device' }))).toBeVisible()
      expect(useSearchProviderStore.getState().connectionStatus).toEqual({ connectionId: id, status: 'available' })
      expect(screen.queryByLabelText('API key')).toBeNull()
    },
  )
})
