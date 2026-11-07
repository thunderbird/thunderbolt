/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, mock } from 'bun:test'
import { createPreviewState } from '../data'
import type { AdminPreview, PreviewAction } from '../use-admin-preview-state'
import { MemberEditor } from './member-editor'

const setup = () => {
  const state = createPreviewState()
  const member = state.members[1]
  const dispatch = mock((_action: PreviewAction) => {})
  const onClose = mock(() => {})
  const preview: AdminPreview = { ...state, state, dispatch }
  render(<MemberEditor member={member} preview={preview} onClose={onClose} />)
  return { member, dispatch, onClose }
}

afterEach(cleanup)

it('previews access from multiple selected groups and saves only when confirmed', () => {
  const { member, dispatch } = setup()
  expect(screen.getByText('Sales Agent')).toBeInTheDocument()
  expect(screen.queryByText('Code Reviewer')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Groups/ }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Engineering' }))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search groups' }), { target: { value: 'Finance' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Finance' }))
  expect(dispatch).not.toHaveBeenCalled()
  expect(screen.getByText('Code Reviewer')).toBeInTheDocument()
  expect(screen.getByText('Finance KB')).toBeInTheDocument()
  expect(screen.queryByRole('checkbox', { name: 'Sales' })).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search groups' }), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(dispatch).toHaveBeenCalledWith({
    type: 'save-member',
    member: { ...member, groupIds: ['sales', 'engineering', 'finance'] },
  })
})

it('removes a group chip from the draft and cancels without changing saved membership', () => {
  const { dispatch, onClose } = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Remove from Sales' }))
  expect(screen.queryByText('Sales Agent')).not.toBeInTheDocument()
  expect(screen.getByText('Thunderbolt')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(dispatch).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('puts removal in the header menu and soft-removes only after confirmation', async () => {
  const { member, dispatch, onClose } = setup()
  expect(screen.queryByRole('button', { name: 'Remove member' })).not.toBeInTheDocument()
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove member' }))
  expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  expect(dispatch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Remove member' }))
  expect(dispatch).toHaveBeenCalledWith({ type: 'remove', kind: 'members', id: member.id, at: expect.any(Number) })
  expect(onClose).toHaveBeenCalledTimes(1)
})
