/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { I18nProvider } from '@lingui/react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, mock, test } from 'bun:test'
import { i18n } from '@/i18n'
import { memoryMcpProviders } from '@/memory/providers'
import { MemoryProviderForm } from './memory-provider-form'

afterEach(cleanup)

test.each(memoryMcpProviders.filter(({ bankScoped }) => !bankScoped))(
  'connects $name through its documented MCP endpoint',
  async (provider) => {
    const onConnect = mock(async (_url: string, _name: string) => {})
    render(
      <I18nProvider i18n={i18n}>
        <MemoryProviderForm provider={provider} pending={false} error={null} onConnect={onConnect} onBack={() => {}} />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: `Connect ${provider.name}` }))
    expect(onConnect).toHaveBeenCalledWith(provider.url, provider.name)
    expect(screen.getByRole('link', { name: 'Setup instructions' })).toHaveAttribute('href', provider.documentationUrl)
    expect(screen.queryByLabelText('API key')).toBeNull()
  },
)

test('Hindsight requires a bank and never silently connects a default bank', () => {
  const provider = memoryMcpProviders.find(({ id }) => id === 'hindsight')!
  const onConnect = mock(async (_url: string, _name: string) => {})
  const view = render(
    <I18nProvider i18n={i18n}>
      <MemoryProviderForm provider={provider} pending={false} error={null} onConnect={onConnect} onBack={() => {}} />
    </I18nProvider>,
  )
  const button = screen.getByRole('button', { name: 'Connect Hindsight Cloud' })
  expect(button).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Memory bank ID'), { target: { value: '../wrong' } })
  expect(button).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Memory bank ID'), { target: { value: 'team-notes' } })
  fireEvent.click(button)
  expect(onConnect).toHaveBeenCalledWith(
    'https://api.hindsight.vectorize.io/mcp/team-notes/',
    'Hindsight Cloud · team-notes',
  )
  view.rerender(
    <I18nProvider i18n={i18n}>
      <MemoryProviderForm provider={provider} pending error={null} onConnect={onConnect} onBack={() => {}} />
    </I18nProvider>,
  )
  expect(button).toBeDisabled()
  expect(screen.getByLabelText('Memory bank ID')).toBeDisabled()
})

test('pending connection prevents duplicate submission and offers cancellation through the shared button', async () => {
  const provider = memoryMcpProviders.find(({ id }) => id === 'supermemory')!
  const connection = Promise.withResolvers<void>()
  const onConnect = mock(() => connection.promise)
  const onCancel = mock(() => connection.resolve())
  const view = render(
    <I18nProvider i18n={i18n}>
      <MemoryProviderForm
        provider={provider}
        pending={false}
        error={null}
        onConnect={onConnect}
        onCancel={onCancel}
        onBack={() => {}}
      />
    </I18nProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Connect Supermemory' }))
  const cancel = screen.getByRole('button', { name: 'Cancel connection' })
  expect(cancel).toBeEnabled()
  fireEvent.submit(view.container.querySelector('form')!)
  expect(onConnect).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  await act(async () => {
    fireEvent.click(cancel)
    await connection.promise
  })
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Connect Supermemory' })).toBeEnabled()
})
