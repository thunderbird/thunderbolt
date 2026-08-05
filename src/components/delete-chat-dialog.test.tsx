/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'

import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import { DeleteChatDialog, type DeleteChatDialogRef } from './delete-chat-dialog'

const setup = () => {
  const ref = createRef<DeleteChatDialogRef>()
  const onCancel = mock(() => {})
  const onConfirm = mock(() => {})
  render(<DeleteChatDialog ref={ref} onCancel={onCancel} onConfirm={onConfirm} />)
  act(() => ref.current?.open())
  return { onCancel, onConfirm }
}

afterEach(() => {
  restoreViewport()
})

describe('DeleteChatDialog', () => {
  it('keeps the alert dialog on desktop', () => {
    setup()

    expect(screen.getByRole('alertdialog', { name: 'Delete this chat?' })).toHaveAttribute(
      'data-slot',
      'alert-dialog-content',
    )
    expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeInTheDocument()
  })

  it('uses an alert bottom sheet on mobile', async () => {
    forceMobileViewport()
    const { onCancel, onConfirm } = setup()

    const sheet = screen.getByRole('alertdialog', { name: 'Delete this chat?' })
    expect(sheet).toHaveAttribute('data-slot', 'drawer-content')
    expect(sheet).toHaveAttribute('data-swipe-direction', 'down')
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Chat' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('disables the confirm button while the delete is pending', () => {
    const ref = createRef<DeleteChatDialogRef>()
    const onConfirm = mock(() => {})
    render(<DeleteChatDialog ref={ref} isPending onConfirm={onConfirm} />)
    act(() => ref.current?.open())

    const confirmButton = screen.getByRole('button', { name: 'Delete Chat' })
    expect(confirmButton).toBeDisabled()
    fireEvent.click(confirmButton)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('runs cancellation cleanup when the mobile sheet is dismissed', () => {
    forceMobileViewport()
    const { onCancel } = setup()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
