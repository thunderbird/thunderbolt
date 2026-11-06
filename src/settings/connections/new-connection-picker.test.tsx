/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { I18nProvider } from '@lingui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, mock, test } from 'bun:test'
import { i18n } from '@/i18n'
import type { ProviderType } from '@/providers/types'
import { NewConnectionPicker } from './new-connection-picker'

afterEach(cleanup)

test('describes both capabilities for Otari and Tinfoil while preserving provider selection', () => {
  const onProvider = mock((_provider: ProviderType) => {})
  render(
    <I18nProvider i18n={i18n}>
      <NewConnectionPicker onProvider={onProvider} onMcp={() => {}} />
    </I18nProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Otari Models and search' }))
  expect(onProvider).toHaveBeenCalledWith('otari')
  expect(screen.getByRole('button', { name: 'Tinfoil Models and search' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'OpenAI Models' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Exa Search' })).toBeInTheDocument()
})

test('keeps generic options first and visually separates them from branded services', () => {
  render(
    <I18nProvider i18n={i18n}>
      <NewConnectionPicker onProvider={() => {}} onMcp={() => {}} />
    </I18nProvider>,
  )
  const buttons = screen.getAllByRole('button')
  expect(buttons[0]).toHaveTextContent('MCP server')
  expect(buttons[1]).toHaveTextContent('OpenAI-compatible model provider')
  expect(buttons[0].parentElement).toHaveClass('border-b')
})

test('filters all connection groups and restores them when the search is cleared', () => {
  const onProvider = mock((_provider: ProviderType) => {})
  const onMcp = mock(() => {})
  const onIntegration = mock((_id: string) => {})
  render(
    <I18nProvider i18n={i18n}>
      <NewConnectionPicker
        onProvider={onProvider}
        onMcp={onMcp}
        onIntegration={onIntegration}
        integrations={[
          {
            id: 'google',
            name: 'Google',
            provider: 'google',
            icon: null,
            connectLabel: 'Connect',
            isEnabled: false,
            isConnected: false,
          },
        ]}
      />
    </I18nProvider>,
  )
  const search = screen.getByRole('searchbox', { name: 'Search connections' })
  expect(search).toHaveFocus()
  fireEvent.change(search, { target: { value: '  OTARI  ' } })
  expect(screen.getAllByRole('button')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Otari Models and search' }))
  expect(onProvider).toHaveBeenCalledWith('otari')
  fireEvent.change(search, { target: { value: 'compatible' } })
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI-compatible model provider' }))
  expect(onProvider).toHaveBeenCalledWith('custom')
  fireEvent.change(search, { target: { value: 'mcp' } })
  fireEvent.click(screen.getByRole('button', { name: 'MCP server' }))
  expect(onMcp).toHaveBeenCalledTimes(1)
  fireEvent.change(search, { target: { value: 'google' } })
  fireEvent.click(screen.getByRole('button', { name: 'Google' }))
  expect(onIntegration).toHaveBeenCalledWith('google')
  fireEvent.change(search, { target: { value: 'no matching provider' } })
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('No connections found.')
  fireEvent.change(search, { target: { value: '' } })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'MCP server' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Otari Models and search' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Google' })).toBeInTheDocument()
})

test('searches within the supported capability instead of exposing unrelated connections', () => {
  render(
    <I18nProvider i18n={i18n}>
      <NewConnectionPicker capability="search" onProvider={() => {}} />
    </I18nProvider>,
  )
  const search = screen.getByRole('searchbox', { name: 'Search connections' })
  fireEvent.change(search, { target: { value: 'models' } })
  expect(screen.getAllByRole('button')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Tinfoil Models and search' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Otari Models and search' })).toBeInTheDocument()
  fireEvent.change(search, { target: { value: 'OpenAI' } })
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('No connections found.')
})
