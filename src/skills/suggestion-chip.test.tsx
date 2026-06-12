/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { SuggestionChip } from './suggestion-chip'

afterEach(cleanup)

const renderChip = (canEdit?: boolean) => {
  const onClick = mock(() => {})
  const onAddInstruction = mock(() => {})
  const onReorder = mock(() => {})
  const onUnpin = mock(() => {})
  render(
    <SuggestionChip
      label="meeting-notes"
      dimmed={false}
      canEdit={canEdit}
      onClick={onClick}
      onAddInstruction={onAddInstruction}
      onReorder={onReorder}
      onUnpin={onUnpin}
    />,
  )
  // Open the chip's dropdown menu — Radix renders the items only when open.
  fireEvent.contextMenu(screen.getByText('/meeting-notes'))
  return { onClick, onAddInstruction, onReorder, onUnpin }
}

describe('SuggestionChip — permission gating', () => {
  it('hides Reorder and Unpin menu items when canEdit is false', () => {
    renderChip(false)

    // Sanity: the always-available items are still rendered.
    expect(screen.getByText('Add to chat')).toBeInTheDocument()
    expect(screen.getByText('Add instructions to chat')).toBeInTheDocument()
    // The two permission-gated items must be hidden.
    expect(screen.queryByText('Reorder')).not.toBeInTheDocument()
    expect(screen.queryByText('Unpin')).not.toBeInTheDocument()
  })

  it('shows Reorder and Unpin when canEdit is true (default)', () => {
    renderChip()

    expect(screen.getByText('Reorder')).toBeInTheDocument()
    expect(screen.getByText('Unpin')).toBeInTheDocument()
  })
})
