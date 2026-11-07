/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { fireEvent, render } from '@testing-library/react'
import { expect, it, mock } from 'bun:test'
import { RenameArtifactDialog } from './rename-artifact-dialog'

it('rejects a blank name and saves a trimmed name with Enter', () => {
  const save = mock(() => {})
  const { getByRole } = render(
    <RenameArtifactDialog title="Original" error={null} isPending={false} onSave={save} onClose={() => {}} />,
  )
  const input = getByRole('textbox', { name: 'Artifact name' })
  fireEvent.change(input, { target: { value: '  ' } })
  expect(getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBeTrue()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '  New name  ' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(save).toHaveBeenCalledWith('New name')
})

it('keeps a failed save visible and lets the user retry', () => {
  const save = mock(() => {})
  const { getByRole } = render(
    <RenameArtifactDialog title="Draft" error="Could not save" isPending={false} onSave={save} onClose={() => {}} />,
  )
  expect(getByRole('alert').textContent).toBe('Could not save')
  fireEvent.click(getByRole('button', { name: 'Save' }))
  expect(save).toHaveBeenCalledWith('Draft')
})
