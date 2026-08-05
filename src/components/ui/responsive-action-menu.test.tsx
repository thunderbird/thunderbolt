/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useState } from 'react'

import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { ResponsiveActionMenu } from './responsive-action-menu'

const Harness = ({ onSelect }: { onSelect: () => void }) => {
  const [open, setOpen] = useState(false)
  return (
    <ResponsiveActionMenu
      open={open}
      onOpenChange={setOpen}
      title="Demo menu"
      trigger={
        <button type="button" aria-label="Open demo menu">
          +
        </button>
      }
      actions={[{ label: 'Do the thing', icon: null, onSelect }]}
    />
  )
}

afterEach(() => {
  cleanup()
  restoreViewport()
})

describe('ResponsiveActionMenu', () => {
  it('opens a card drawer on mobile and closes before running the action', () => {
    forceMobileViewport()
    const onSelect = mock(() => {})
    render(<Harness onSelect={onSelect} />)

    const trigger = screen.getByRole('button', { name: 'Open demo menu' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Do the thing' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders a dropdown menu on desktop', () => {
    const onSelect = mock(() => {})
    render(<Harness onSelect={onSelect} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open demo menu' }), { button: 0, ctrlKey: false })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Do the thing' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
