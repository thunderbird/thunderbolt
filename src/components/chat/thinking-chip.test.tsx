/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ThinkingChip } from './thinking-chip'

afterEach(() => {
  cleanup()
})

describe('ThinkingChip', () => {
  it('exposes pressed state and toggles on click', () => {
    const onToggle = mock(() => undefined)
    render(<ThinkingChip enabled onToggle={onToggle} />)

    const button = screen.getByRole('button', { name: 'Thinking on' })
    expect(button.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('labels the off state for assistive tech', () => {
    render(<ThinkingChip enabled={false} onToggle={() => undefined} />)
    const button = screen.getByRole('button', { name: 'Thinking off' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })
})
