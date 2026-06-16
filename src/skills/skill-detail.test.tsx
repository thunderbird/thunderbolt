/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { SkillDetail } from './skill-detail'

afterEach(cleanup)

const renderDetail = (props: { canEdit?: boolean; canDelete?: boolean } = {}) => {
  render(
    <MemoryRouter>
      <SkillDetail
        name="meeting-notes"
        description="desc"
        instruction="do"
        enabled
        canEdit={props.canEdit}
        canDelete={props.canDelete}
        onToggleEnabled={mock(() => {})}
        onEdit={mock(() => {})}
        onDelete={mock(() => {})}
      />
    </MemoryRouter>,
  )
}

const openMenu = () => {
  // Radix DropdownMenuTrigger listens on pointerdown for primary clicks.
  const trigger = screen.getByRole('button', { name: /More/ })
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
}

describe('SkillDetail — permission gating', () => {
  it('disables the enable toggle when canEdit is false', () => {
    renderDetail({ canEdit: false })

    expect(screen.getByRole('switch', { name: /Disable skill/ })).toBeDisabled()
  })

  it('hides the Edit menu item when canEdit is false', () => {
    renderDetail({ canEdit: false })
    openMenu()

    expect(screen.queryByText('Edit')).not.toBeInTheDocument()
  })

  it('hides the Delete menu item when canDelete is false', () => {
    renderDetail({ canDelete: false })
    openMenu()

    expect(screen.queryByText('Delete')).not.toBeInTheDocument()
  })

  it('shows Edit and Delete by default', () => {
    renderDetail()
    openMenu()

    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })
})
