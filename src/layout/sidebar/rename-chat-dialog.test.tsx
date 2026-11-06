/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import { RenameChatDialog } from './rename-chat-dialog'

const setup = (title: string | null = 'My Chat') => {
  const onOpenChange = mock()
  const onRename = mock()
  const view = render(<RenameChatDialog open title={title} onOpenChange={onOpenChange} onRename={onRename} />)
  return { ...view, onOpenChange, onRename }
}

afterEach(() => {
  restoreViewport()
})

describe('RenameChatDialog', () => {
  it('uses the desktop dialog at desktop widths', () => {
    setup()

    expect(screen.getByText('Rename chat').closest('[data-slot="dialog-content"]')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeInTheDocument()
  })

  it('uses a bottom sheet on mobile', async () => {
    forceMobileViewport()
    setup()

    const sheet = screen.getByRole('dialog', { name: 'Rename chat' })
    expect(sheet).toHaveAttribute('data-slot', 'drawer-content')
    expect(sheet).toHaveAttribute('data-swipe-direction', 'down')
    await act(async () => {
      await getClock().runAllAsync()
    })
    const input = screen.getByDisplayValue('My Chat') as HTMLInputElement
    expect(input).toHaveFocus()
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeInTheDocument()
  })

  it('discards a canceled mobile draft before the next open', () => {
    forceMobileViewport()
    const { onOpenChange, onRename, rerender } = setup()

    const input = screen.getByRole('textbox', { name: 'Chat name' })
    fireEvent.change(input, { target: { value: 'Unsaved title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    rerender(<RenameChatDialog open={false} title="My Chat" onOpenChange={onOpenChange} onRename={onRename} />)
    expect(input).toHaveValue('Unsaved title')
    rerender(<RenameChatDialog open title="My Chat" onOpenChange={onOpenChange} onRename={onRename} />)

    expect(screen.getByRole('textbox', { name: 'Chat name' })).toHaveValue('My Chat')
  })

  it('preserves the draft if the viewport crosses the mobile breakpoint', async () => {
    forceMobileViewport()
    const { onOpenChange, onRename, rerender } = setup()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat name' }), {
      target: { value: 'Unsaved title' },
    })
    act(() => restoreViewport())
    rerender(<RenameChatDialog open title="My Chat" onOpenChange={onOpenChange} onRename={onRename} />)
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('Rename chat').closest('[data-slot="dialog-content"]')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Chat name' })).toHaveValue('Unsaved title')
  })

  it('keeps the dialog mounted when the title prop updates while open', () => {
    const { onOpenChange, onRename, rerender } = setup()

    const input = screen.getByRole('textbox', { name: 'Chat name' })
    fireEvent.change(input, { target: { value: 'Draft title' } })
    // e.g. the rename mutation lands while the dialog is animating — the
    // form must not remount (which would cut the close animation) and the
    // draft must survive.
    rerender(<RenameChatDialog open title="Renamed elsewhere" onOpenChange={onOpenChange} onRename={onRename} />)

    expect(screen.getByRole('textbox', { name: 'Chat name' })).toBe(input)
    expect(input).toHaveValue('Draft title')
  })

  it('resets to the latest title on reopen after the title changed', () => {
    const { onOpenChange, onRename, rerender } = setup()

    rerender(<RenameChatDialog open={false} title="Renamed" onOpenChange={onOpenChange} onRename={onRename} />)
    rerender(<RenameChatDialog open title="Renamed" onOpenChange={onOpenChange} onRename={onRename} />)

    expect(screen.getByRole('textbox', { name: 'Chat name' })).toHaveValue('Renamed')
  })

  it('renders with the current title in the input', () => {
    setup()
    expect(screen.getByDisplayValue('My Chat')).toBeInTheDocument()
  })

  it('uses "New Chat" when title is null', () => {
    setup(null)
    expect(screen.getByDisplayValue('New Chat')).toBeInTheDocument()
  })

  it('saves on Enter key', () => {
    const { onRename, onOpenChange } = setup()
    const input = screen.getByDisplayValue('My Chat')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRename).toHaveBeenCalledWith('Renamed')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('saves on Save button click', () => {
    const { onRename, onOpenChange } = setup()
    const input = screen.getByDisplayValue('My Chat')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByText('Save'))

    expect(onRename).toHaveBeenCalledWith('Renamed')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes on Cancel button click', () => {
    const { onRename, onOpenChange } = setup()
    fireEvent.click(screen.getByText('Cancel'))

    expect(onRename).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('blurs and closes on the first mobile cancel touch', () => {
    forceMobileViewport()
    const { onOpenChange } = setup()
    const input = screen.getByRole('textbox', { name: 'Chat name' })
    input.focus()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Cancel' }), { pointerType: 'touch' })

    expect(input).not.toHaveFocus()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('trims whitespace and falls back to "New Chat"', () => {
    const { onRename } = setup()
    const input = screen.getByDisplayValue('My Chat')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByText('Save'))

    expect(onRename).toHaveBeenCalledWith('New Chat')
  })

  it('does not call onRename when title is unchanged', () => {
    const { onRename, onOpenChange } = setup()
    fireEvent.click(screen.getByText('Save'))

    expect(onRename).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
