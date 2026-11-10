/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { I18nProvider } from '@lingui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, mock, test } from 'bun:test'
import { i18n } from '@/i18n'
import { ProviderConnectionButton } from './provider-connection-button'

afterEach(cleanup)

test('turns a pending connection into a cancel action on hover and keyboard focus', () => {
  const cancel = mock(() => {})
  const connect = mock(() => {})
  render(
    <I18nProvider i18n={i18n}>
      <ProviderConnectionButton
        isConnected={false}
        isProcessing
        connectLabel="Connect Otari"
        onConnect={connect}
        onCancel={cancel}
      />
    </I18nProvider>,
  )
  const button = screen.getByRole('button', { name: 'Cancel connection' })
  expect(button).toBeEnabled()
  expect(button).toHaveTextContent('Connecting…')
  fireEvent.mouseEnter(button)
  expect(button).toHaveTextContent('Cancel')
  fireEvent.mouseLeave(button)
  expect(button).toHaveTextContent('Connecting…')
  fireEvent.focus(button)
  expect(button).toHaveTextContent('Cancel')
  fireEvent.click(button)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(connect).not.toHaveBeenCalled()
})

test('keeps non-cancellable work disabled', () => {
  render(
    <I18nProvider i18n={i18n}>
      <ProviderConnectionButton isConnected={false} isProcessing connectLabel="Connect" onConnect={() => {}} />
    </I18nProvider>,
  )
  expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
})
