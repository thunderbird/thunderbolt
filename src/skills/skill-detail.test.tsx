/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { SkillDetail } from './skill-detail'

afterEach(cleanup)

const renderDetail = (
  props: {
    canEdit?: boolean
    canDelete?: boolean
    scope?: 'workspace' | 'user'
    showScope?: boolean
  } = {},
) => {
  render(
    <MemoryRouter>
      <SkillDetail
        name="meeting-notes"
        description="desc"
        instruction="do"
        enabled
        canEdit={props.canEdit}
        canDelete={props.canDelete}
        scope={props.scope}
        showScope={props.showScope}
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

describe('SkillDetail — read-only scope picker (THU-603)', () => {
  it('does not render the scope picker when showScope is false', () => {
    renderDetail({ scope: 'workspace', showScope: false })
    expect(screen.queryByRole('radio', { name: /shared with the workspace/i })).not.toBeInTheDocument()
  })

  it("reflects scope='workspace' as the selected option, read-only", () => {
    renderDetail({ scope: 'workspace', showScope: true })
    const workspaceItem = screen.getByRole('radio', { name: /shared with the workspace/i })
    expect(workspaceItem).toHaveAttribute('data-state', 'on')
    // Read-only must not dim the items (no disabled attribute) — the picker is
    // informational, not an "unavailable" control.
    expect(workspaceItem).not.toBeDisabled()
    expect(screen.getByText(/shared with everyone/i)).toBeInTheDocument()
  })

  it("reflects scope='user' as the selected option with the private hint", () => {
    renderDetail({ scope: 'user', showScope: true })
    const privateItem = screen.getByRole('radio', { name: /private to you/i })
    expect(privateItem).toHaveAttribute('data-state', 'on')
    expect(screen.getByText(/only you can see/i)).toBeInTheDocument()
  })

  it('does not render the picker when scope is undefined (defensive)', () => {
    renderDetail({ scope: undefined, showScope: true })
    expect(screen.queryByRole('radio', { name: /shared with the workspace/i })).not.toBeInTheDocument()
  })
})
