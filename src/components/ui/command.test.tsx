/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import '@testing-library/jest-dom'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { useState } from 'react'
import { CommandDialog } from './command'

afterEach(cleanup)

const flush = () =>
  act(async () => {
    await getClock().runAllAsync()
  })

const Harness = ({ stealFocus = false }: { stealFocus?: boolean }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open palette</button>
      <input aria-label="Elsewhere" />
      <CommandDialog
        open={open}
        // Non-modal so the test can move focus out during close, as a command's destination would.
        modal={!stealFocus}
        onOpenChange={(next) => {
          if (!next && stealFocus) {
            screen.getByLabelText('Elsewhere').focus()
          }
          setOpen(next)
        }}
      >
        <div>Palette body</div>
      </CommandDialog>
    </>
  )
}

describe('CommandDialog focus return', () => {
  it('returns focus to the opener on Escape', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open palette' })
    opener.focus()
    fireEvent.click(opener)
    await flush()
    expect(screen.getByText('Palette body')).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await flush()
    expect(document.activeElement).toBe(opener)
  })

  it('does not steal focus another element claimed on close', async () => {
    render(<Harness stealFocus />)
    const opener = screen.getByRole('button', { name: 'Open palette' })
    opener.focus()
    fireEvent.click(opener)
    await flush()
    expect(screen.getByText('Palette body')).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await flush()
    expect(document.activeElement).toBe(screen.getByLabelText('Elsewhere'))
  })
})
