/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { setupI18n } from '@lingui/core'
import { I18nProvider, Trans } from '@lingui/react'
import * as linguiMacros from '@lingui/react/macro'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import * as modelDisplayName from './model-display-name'
import { ProviderModelOption } from './provider-model-option'

afterEach(() => {
  cleanup()
  mock.restore()
})

it('only recomputes the changed catalog row when selecting a model', () => {
  const first = { id: 'one', name: 'First model' }
  const second = { id: 'two', name: 'Second model' }
  const toggle = mock(() => {})
  const displayName = spyOn(modelDisplayName, 'getModelDisplayName')
  const options = (selected: boolean) => (
    <>
      <ProviderModelOption model={first} selected={selected} added={false} disabled={false} onToggle={toggle} />
      <ProviderModelOption model={second} selected={false} added={false} disabled={false} onToggle={toggle} />
    </>
  )
  const { rerender } = render(options(false))
  displayName.mockClear()
  rerender(options(false))
  expect(displayName).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('checkbox', { name: 'First model' }))
  expect(toggle).toHaveBeenCalledWith('one')
  rerender(options(true))
  expect(displayName.mock.calls).toEqual([[first]])
  expect(screen.getByRole('checkbox', { name: 'First model' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Second model' })).not.toBeChecked()
})

it('updates catalog labels, saved status, pending state, and the active toggle handler', () => {
  const model = { id: 'vendor/model-v1', name: 'Original name' }
  const toggle = mock(() => {})
  const props = { model, selected: false, added: false, disabled: false, onToggle: toggle }
  const { rerender } = render(<ProviderModelOption {...props} />)
  const renamed = { ...model, name: 'Updated catalog name' }
  rerender(<ProviderModelOption {...props} model={renamed} added />)
  const added = screen.getByRole('checkbox', { name: renamed.name })
  expect(screen.queryByRole('checkbox', { name: model.name })).toBeNull()
  expect(added).toBeChecked()
  expect(added).toBeDisabled()
  expect(screen.getByText('Added')).toBeInTheDocument()

  rerender(<ProviderModelOption {...props} selected disabled />)
  const pending = screen.getByRole('checkbox', { name: model.name })
  expect(pending).toBeChecked()
  expect(pending).toBeDisabled()
  expect(screen.queryByText('Added')).toBeNull()
  fireEvent.click(pending)
  expect(toggle).not.toHaveBeenCalled()

  const replacementToggle = mock(() => {})
  rerender(<ProviderModelOption {...props} onToggle={replacementToggle} />)
  const available = screen.getByRole('checkbox', { name: model.name })
  expect(available).toBeEnabled()
  expect(available).not.toBeChecked()
  fireEvent.click(available)
  expect(replacementToggle).toHaveBeenCalledWith(model.id)
  expect(toggle).not.toHaveBeenCalled()
})

it('keeps the translated saved status reactive inside an unchanged memoized row', () => {
  // Bun uses identity macros; exercise the real Lingui child used by the production transform.
  spyOn(linguiMacros, 'Trans').mockImplementation(() => <Trans id="Added" />)
  const i18n = setupI18n({ locale: 'en', messages: { en: { Added: 'Added' }, de: { Added: 'Hinzugefügt' } } })
  const model = { id: 'model', name: 'Model' }
  const toggle = mock(() => {})
  render(
    <I18nProvider i18n={i18n}>
      <ProviderModelOption model={model} selected={false} added disabled={false} onToggle={toggle} />
    </I18nProvider>,
  )
  expect(screen.getByText('Added')).toBeInTheDocument()
  act(() => i18n.activate('de'))
  expect(screen.getByText('Hinzugefügt')).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Model' })).toBeDisabled()
})
