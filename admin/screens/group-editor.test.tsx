/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { createPreviewState, type PreviewGroup } from '../data'
import type { AdminPreview, PreviewAction } from '../use-admin-preview-state'
import { GroupEditor } from './group-editor'

const renderGroupEditor = (group?: PreviewGroup) => {
  const state = createPreviewState()
  const dispatch = mock((_action: PreviewAction) => {})
  const onClose = mock(() => {})
  const preview: AdminPreview = { ...state, state, dispatch }
  render(<GroupEditor group={group} preview={preview} onClose={onClose} />, { wrapper: MemoryRouter })
  return { state, dispatch, onClose }
}

const engineering = createPreviewState().groups.find((group) => group.id === 'engineering')!

describe('GroupEditor', () => {
  it('keeps name and member edits as drafts, then submits them together', () => {
    const { dispatch, onClose } = renderGroupEditor(engineering)
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: '  Platform engineering  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Avery Morgan' }))
    expect(dispatch).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({
      type: 'save-group',
      group: { ...engineering, name: 'Platform engineering' },
      memberIds: ['taylor'],
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('discards group and membership drafts when canceled', () => {
    const { dispatch, onClose, state } = renderGroupEditor(engineering)
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Draft name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Taylor Quinn' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(dispatch).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(state.groups.find((group) => group.id === 'engineering')?.name).toBe('Engineering')
    expect(state.members.find((member) => member.id === 'taylor')?.groupIds).toEqual(['engineering'])
  })

  it('supports choosing members before creating a new group', () => {
    const { dispatch } = renderGroupEditor()
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Design team' } })
    fireEvent.click(screen.getByLabelText('Members'))
    fireEvent.click(screen.getByRole('checkbox', { name: /Jamie Chen/ }))
    expect(dispatch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({
      type: 'save-group',
      group: { id: expect.any(String), name: 'Design team', deletedAt: null },
      memberIds: ['jamie'],
    })
  })

  it('places remove group in the header menu and requires confirmation', () => {
    const { dispatch, onClose } = renderGroupEditor(engineering)
    expect(screen.queryByRole('button', { name: 'Remove group' })).not.toBeInTheDocument()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove group' }))
    expect(dispatch).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove group' }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'remove', kind: 'groups', id: 'engineering', at: expect.any(Number) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
