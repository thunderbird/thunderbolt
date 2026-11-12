/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { I18nProvider } from '@lingui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, mock, test } from 'bun:test'
import type { ComponentProps } from 'react'
import { i18n } from '@/i18n'
import { memoryMcpProviders } from '@/memory/providers'
import { MemoryConnectionStatus } from './memory-connection-status'

afterEach(cleanup)

/** Render a connection with explicit transport and OAuth state, without a live provider. */
const renderStatus = (overrides: Partial<ComponentProps<typeof MemoryConnectionStatus>> = {}) => {
  const props = {
    provider: memoryMcpProviders[0],
    enabled: true,
    status: 'disconnected',
    oauthState: null,
    connectionError: null,
    actionError: null,
    isRetrying: false,
    onRetry: mock(() => {}),
    onAuthorize: mock(() => {}),
    onCancelAuthorize: mock(() => {}),
    onEnable: mock(() => {}),
    ...overrides,
  } satisfies ComponentProps<typeof MemoryConnectionStatus>
  render(
    <I18nProvider i18n={i18n}>
      <MemoryConnectionStatus {...props} />
    </I18nProvider>,
  )
  return props
}

test.each(memoryMcpProviders)(
  '$name shows connected only for a live enabled transport, with reauthorization',
  (provider) => {
    const props = renderStatus({ provider, status: 'connected' })
    expect(screen.getByRole('heading', { name: `Connected to ${provider.name}` })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Ready to use as your memory provider.')
    fireEvent.click(screen.getByRole('button', { name: 'Re-authorize' }))
    expect(props.onAuthorize).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: 'Setup instructions' })).toHaveAttribute('href', provider.documentationUrl)
    expect(screen.queryByText(provider.url, { exact: true })).toBeNull()
    expect(screen.queryByText('Server URL', { exact: true })).toBeNull()
    expect(screen.queryByText(/Transport:/)).toBeNull()
  },
)

test('stored authorization alone does not claim a live connection', () => {
  const props = renderStatus({ oauthState: { phase: 'authorized' } })
  expect(screen.queryByRole('heading', { name: 'Connected to Supermemory' })).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent('Connect on this device')
  fireEvent.click(screen.getByRole('button', { name: 'Connect Supermemory' }))
  expect(props.onAuthorize).toHaveBeenCalledTimes(1)
  expect(props.onRetry).not.toHaveBeenCalled()
})

test('an OAuth attempt offers cancellation instead of another connect action', () => {
  const props = renderStatus({ oauthState: { phase: 'authorizing' } })
  const cancel = screen.getByRole('button', { name: 'Cancel connection' })
  expect(cancel).toBeEnabled()
  fireEvent.click(cancel)
  expect(props.onCancelAuthorize).toHaveBeenCalledTimes(1)
  expect(props.onAuthorize).not.toHaveBeenCalled()
})

test('a network failure offers transport retry and does not claim connected', () => {
  const props = renderStatus({ status: 'connected', connectionError: new Error('Provider is temporarily unavailable') })
  expect(screen.queryByRole('heading', { name: 'Connected to Supermemory' })).toBeNull()
  expect(screen.getByRole('alert')).toHaveTextContent('Provider is temporarily unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
  expect(props.onRetry).toHaveBeenCalledTimes(1)
  expect(props.onAuthorize).not.toHaveBeenCalled()
})

test.each([{ status: 'connecting' as const }, { isRetrying: true }])(
  'blocks a duplicate action during transport work (%j)',
  (state) => {
    const props = renderStatus(state)
    const connecting = screen.getByRole('button', { name: 'Connecting…' })
    expect(connecting).toBeDisabled()
    fireEvent.click(connecting)
    expect(props.onRetry).not.toHaveBeenCalled()
    expect(props.onAuthorize).not.toHaveBeenCalled()
  },
)

test('a disabled connection must be enabled before it can report ready', () => {
  const props = renderStatus({ enabled: false, status: 'connected' })
  expect(screen.getByRole('status')).toHaveTextContent('This connection is disabled.')
  expect(screen.queryByRole('heading', { name: 'Connected to Supermemory' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Enable connection' }))
  expect(props.onEnable).toHaveBeenCalledTimes(1)
  expect(props.onAuthorize).not.toHaveBeenCalled()
})

test('disabled state cannot silently start authorization without an enable handler', () => {
  const props = renderStatus({ enabled: false, onEnable: undefined })
  const enable = screen.getByRole('button', { name: 'Enable connection' })
  expect(enable).toBeDisabled()
  fireEvent.click(enable)
  expect(props.onAuthorize).not.toHaveBeenCalled()
})

test('authorization failures are visible and can be retried through Connect', () => {
  const props = renderStatus({ oauthState: { phase: 'error', message: 'Authorization was declined.' } })
  expect(screen.getByRole('alert')).toHaveTextContent('Authorization was declined.')
  fireEvent.click(screen.getByRole('button', { name: 'Connect Supermemory' }))
  expect(props.onAuthorize).toHaveBeenCalledTimes(1)
})
