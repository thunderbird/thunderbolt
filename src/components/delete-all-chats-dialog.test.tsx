/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'

import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import { DeleteAllChatsDialog, type DeleteAllChatsDialogRef } from './delete-all-chats-dialog'

afterEach(() => {
  restoreViewport()
})

describe('DeleteAllChatsDialog', () => {
  it('keeps the alert dialog on desktop', () => {
    const ref = createRef<DeleteAllChatsDialogRef>()
    render(<DeleteAllChatsDialog ref={ref} onConfirm={() => {}} />)
    act(() => ref.current?.open())

    expect(screen.getByRole('alertdialog', { name: 'Delete all chats?' })).toHaveAttribute(
      'data-slot',
      'alert-dialog-content',
    )
    expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeInTheDocument()
  })

  it('uses an alert bottom sheet on mobile', async () => {
    forceMobileViewport()
    const ref = createRef<DeleteAllChatsDialogRef>()
    const onConfirm = mock(() => {})
    render(<DeleteAllChatsDialog ref={ref} onConfirm={onConfirm} />)
    act(() => ref.current?.open())

    const sheet = screen.getByRole('alertdialog', { name: 'Delete all chats?' })
    expect(sheet).toHaveAttribute('data-slot', 'drawer-content')
    expect(sheet).toHaveAttribute('data-swipe-direction', 'down')
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Delete All Chats' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('disables the confirm button while the delete is pending', () => {
    const ref = createRef<DeleteAllChatsDialogRef>()
    const onConfirm = mock(() => {})
    render(<DeleteAllChatsDialog ref={ref} isPending onConfirm={onConfirm} />)
    act(() => ref.current?.open())

    const confirmButton = screen.getByRole('button', { name: 'Delete All Chats' })
    expect(confirmButton).toBeDisabled()
    fireEvent.click(confirmButton)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
