/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useState } from 'react'
import { getClock } from '@/testing-library'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

const PickerNextToComposer = () => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <textarea aria-label="Composer" />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger>Pick model</PopoverTrigger>
        <PopoverContent onOpenAutoFocus={(event) => event.preventDefault()}>
          <button type="button" onClick={() => setOpen(false)}>
            Opus
          </button>
        </PopoverContent>
      </Popover>
    </>
  )
}

/** Radix restores focus from a zero-delay timer after the content unmounts. */
const flushCloseAutoFocus = () =>
  act(async () => {
    await getClock().tickAsync(20)
  })

describe('PopoverContent close focus', () => {
  it('keeps focus that moved outside while the popover was closing', async () => {
    render(<PickerNextToComposer />)
    fireEvent.click(screen.getByRole('button', { name: 'Pick model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Opus' }))
    const composer = screen.getByRole('textbox', { name: 'Composer' })
    composer.focus()

    await flushCloseAutoFocus()

    expect(document.activeElement).toBe(composer)
  })

  it('returns focus to the trigger when focus was inside the popover', async () => {
    render(<PickerNextToComposer />)
    const trigger = screen.getByRole('button', { name: 'Pick model' })
    fireEvent.click(trigger)
    const option = screen.getByRole('button', { name: 'Opus' })
    option.focus()
    fireEvent.keyDown(option, { key: 'Escape' })

    await flushCloseAutoFocus()

    expect(document.activeElement).toBe(trigger)
  })
})
