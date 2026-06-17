/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { LibraryRow } from './library-row'
import type { Skill } from '@/types'
// Import for side effect: registers the framer-motion `mock.module` so
// `m.li` from library-row.tsx renders to a plain `<li>` in jsdom.
import '@/test-utils/framer-motion-mock'

afterEach(cleanup)

const skill: Skill = {
  id: 's1',
  name: 'meeting-notes',
  description: 'desc',
  instruction: 'do',
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
  workspaceId: null,
  scope: null,
}

const renderRow = (props: { canEdit?: boolean; canDelete?: boolean } = {}) => {
  render(
    <MemoryRouter>
      <ul>
        <LibraryRow
          skill={skill}
          enabled
          isActive={false}
          canEdit={props.canEdit}
          canDelete={props.canDelete}
          onSelect={mock(() => {})}
          onToggleEnabled={mock(() => {})}
          onEdit={mock(() => {})}
          onDelete={mock(() => {})}
        />
      </ul>
    </MemoryRouter>,
  )
}

const openMenu = () => {
  // Radix DropdownMenuTrigger listens on pointerdown for primary clicks.
  const trigger = screen.getByRole('button', { name: /Open \/meeting-notes menu/ })
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
}

describe('LibraryRow — permission gating', () => {
  it('disables the enable toggle when canEdit is false', () => {
    renderRow({ canEdit: false })

    const toggle = screen.getByRole('switch', { name: /Disable \/meeting-notes/ })
    expect(toggle).toBeDisabled()
  })

  it('hides the Edit menu item when canEdit is false', () => {
    renderRow({ canEdit: false })
    openMenu()

    expect(screen.queryByText('Edit')).not.toBeInTheDocument()
  })

  it('hides the Delete menu item when canDelete is false', () => {
    renderRow({ canDelete: false })
    openMenu()

    expect(screen.queryByText('Delete')).not.toBeInTheDocument()
  })

  it('shows Edit and Delete by default (both permissions implicit-true)', () => {
    renderRow()
    openMenu()

    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })
})
