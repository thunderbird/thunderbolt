/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fireEvent, render } from '@testing-library/react'
import { expect, it, mock } from 'bun:test'
import { RenameDialog } from './rename-dialog'

it('does not submit an IME composition when Enter accepts the composed text', () => {
  const rename = mock(() => undefined)
  const view = render(
    <RenameDialog open name="Page" title="Rename" inputLabel="Name" onOpenChange={() => {}} onRename={rename} />,
  )
  const input = view.getByRole('textbox', { name: 'Name' })
  fireEvent.change(input, { target: { value: '東京' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(rename).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter', isComposing: false })
  expect(rename).toHaveBeenCalledWith('東京')
})
