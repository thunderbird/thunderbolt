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
  expect(buttons[1]).toHaveTextContent('OpenAI-compatible')
  expect(buttons[0].parentElement).toHaveClass('border-b')
})
