/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, mock } from 'bun:test'
import { Dialog, DialogTitle } from '@/components/ui/dialog'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import { EmojiPicker } from './emoji-picker'

afterEach(restoreViewport)

it('keeps the mobile picker above its project dialog, with search focus and native emoji selection', async () => {
  forceMobileViewport()
  const onChange = mock(() => {})
  render(
    <Dialog open>
      <ResponsiveModalContentComposable aria-describedby={undefined}>
        <DialogTitle>Create project</DialogTitle>
        <EmojiPicker value={null} onChange={onChange} label="Research" />
      </ResponsiveModalContentComposable>
    </Dialog>,
  )
  const editor = screen.getByRole('dialog', { name: 'Create project' })
  fireEvent.click(screen.getByRole('button', { name: 'Choose an icon for Research' }))
  const picker = screen.getByRole('dialog', { name: 'Choose an icon' })
  expect(editor).toContainElement(picker)
  const search = screen.getByRole('textbox', { name: 'Search emoji' })
  await act(async () => {
    await getClock().tickAsync(500)
  })
  act(() => search.focus())
  await act(async () => {
    await getClock().tickAsync(20)
  })
  expect(search).toHaveFocus()
  expect(screen.getByRole('button', { name: '📊' })).toHaveTextContent('📊')
  fireEvent.click(screen.getByRole('button', { name: '📊' }))
  expect(onChange).toHaveBeenCalledWith('📊')
  await act(async () => {
    await getClock().tickAsync(500)
  })
  expect(screen.queryByRole('dialog', { name: 'Choose an icon' }) === null).toBe(true)
})
