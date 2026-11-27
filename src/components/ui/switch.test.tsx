/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { Switch } from './switch'

afterEach(cleanup)

describe('Switch', () => {
  it('outlines the off-state track and thumb with border-strong for 3:1 non-text contrast', () => {
    render(<Switch aria-label="Toggle" />)
    const track = screen.getByRole('switch')
    expect(track).toHaveClass('border-border-strong')
    expect(track).not.toHaveClass('border-border')
    expect(track.querySelector('[data-slot="switch-thumb"]')).toHaveClass('data-[state=unchecked]:bg-border-strong')
  })
})
