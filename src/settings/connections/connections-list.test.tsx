/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { I18nProvider } from '@lingui/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ComponentProps } from 'react'

import { i18n } from '@/i18n'
import type { ProviderConnection } from '@/providers/types'
import { getClock } from '@/testing-library'
import type { McpServer } from '@/types'
import { ConnectionsList } from './connections-list'
import type { Integration } from './types'

const thunderbolt: Integration = {
  id: 'thunderbolt',
  name: 'Thunderbolt',
  provider: 'thunderbolt-pro',
  connectLabel: 'Get Pro',
  icon: null,
  isEnabled: true,
  isConnected: true,
}

const provider: ProviderConnection = {
  id: 'provider-1',
  provider: 'otari',
  name: 'Work Otari',
  authMethod: 'oauth',
  url: 'https://otari.example/api/v1',
  enabled: 1,
  connected: true,
  createdAt: '2026-11-05T12:00:00Z',
  updatedAt: '2026-11-05T12:00:00Z',
  deletedAt: null,
  userId: null,
}

const server: McpServer = {
  id: 'server-1',
  name: 'Team tools',
  type: 'http',
  url: 'https://tools.example/mcp',
  command: null,
  args: null,
  enabled: 1,
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
  userId: null,
}

const renderList = (overrides: Partial<ComponentProps<typeof ConnectionsList>> = {}) => {
  const props: ComponentProps<typeof ConnectionsList> = {
    aiProviders: [],
    areProvidersReady: true,
    onToggleProvider: mock(() => {}),
    isProviderTogglePending: false,
    providerError: null,
    onSelectProvider: mock(() => {}),
    onEditProvider: mock(() => {}),
    onRemoveProvider: mock(() => {}),
    onRemoveIntegration: mock(() => {}),
    integrations: [],
    areIntegrationsReady: true,
    servers: [],
    areServersReady: true,
    serverStatus: () => 'error',
    activeKey: null,
    onAdd: mock(() => {}),
    onSelectIntegration: mock(() => {}),
    onSelectServer: mock(() => {}),
    onToggleIntegration: mock(() => {}),
    onToggleServer: mock(() => {}),
    onEditServer: mock(() => {}),
    onDeleteServer: mock(() => {}),
    ...overrides,
  }
  const view = render(
    <I18nProvider i18n={i18n}>
      <ConnectionsList {...props} />
    </I18nProvider>,
  )
  return { ...view, props }
}

afterEach(cleanup)

describe('ConnectionsList busy state', () => {
  it.each(['areProvidersReady', 'areIntegrationsReady', 'areServersReady'] as const)(
    'is aria-busy while %s is false',
    (ready) => {
      const { container } = renderList({ [ready]: false })
      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
    },
  )

  it('drops aria-busy once every source is ready', () => {
    const { container } = renderList()
    expect(container.querySelector('[aria-busy]')).toBeNull()
  })
})

describe('ConnectionsList empty state', () => {
  it('offers the general add flow only when all connection sources are loaded and empty', () => {
    const { props } = renderList()
    expect(screen.getByRole('heading', { name: 'No connections yet' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    expect(props.onAdd).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Add your first server')).not.toBeInTheDocument()
  })

  it.each(['areProvidersReady', 'areIntegrationsReady', 'areServersReady'] as const)(
    'waits for %s before showing an empty state',
    (ready) => {
      renderList({ [ready]: false })
      expect(screen.queryByRole('heading', { name: 'No connections yet' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Add connection' })).not.toBeInTheDocument()
      expect(screen.queryByText('No matching connections.')).not.toBeInTheDocument()
    },
  )

  it.each([
    { isEnabled: true, isConnected: true },
    { isEnabled: false, isConnected: true },
    { isEnabled: false, isConnected: false },
  ])('treats a Thunderbolt-only list as populated (%j)', (state) => {
    renderList({ integrations: [{ ...thunderbolt, ...state }] })
    expect(screen.getByRole('button', { name: 'Open Thunderbolt' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No connections yet' })).not.toBeInTheDocument()
    expect(screen.queryByText('Add your first server')).not.toBeInTheDocument()
  })

  it.each([
    { enabled: 1, connected: true },
    { enabled: 0, connected: true },
    { enabled: 1, connected: false },
  ])('treats a provider-only list as populated (%j)', (state) => {
    renderList({ aiProviders: [{ ...provider, ...state }] })
    expect(screen.getByRole('button', { name: 'Open Work Otari' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No connections yet' })).not.toBeInTheDocument()
    expect(screen.queryByText('Add your first server')).not.toBeInTheDocument()
  })

  it.each([0, 1])('treats an MCP-only list as populated even when disconnected (enabled: %i)', (enabled) => {
    renderList({ servers: [{ ...server, enabled }] })
    expect(screen.getByRole('button', { name: 'Open Team tools' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No connections yet' })).not.toBeInTheDocument()
    expect(screen.queryByText('Add your first server')).not.toBeInTheDocument()
  })

  it.each([{ integrations: [] }, { integrations: [thunderbolt] }])(
    'keeps the search no-matches state distinct from an empty list (%j)',
    async (rows) => {
      renderList({ integrations: [...rows.integrations] })
      fireEvent.click(screen.getByRole('button', { name: 'Search' }))
      fireEvent.change(screen.getByPlaceholderText('Search connections'), { target: { value: 'no such connection' } })
      await act(async () => {
        await getClock().runAllAsync()
      })
      expect(screen.getByText('No matching connections.')).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'No connections yet' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Add connection' })).not.toBeInTheDocument()
    },
  )
})
