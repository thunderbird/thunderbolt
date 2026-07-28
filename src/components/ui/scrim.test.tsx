/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { Scrim } from './scrim'

describe('Scrim', () => {
  afterEach(cleanup)

  it('defaults to a masked top-edge blur', () => {
    render(<Scrim data-testid="scrim" height="6rem" />)

    const scrim = screen.getByTestId('scrim')
    expect(scrim).toHaveClass('top-0', 'bg-gradient-to-b', 'backdrop-blur-[4px]')
    expect(scrim.style.height).toBe('6rem')
    expect(scrim.style.maskImage).toBe('linear-gradient(to bottom, black 20%, transparent 100%)')
  })

  it('can invert the treatment for bottom-pinned controls', () => {
    render(<Scrim data-testid="scrim" edge="bottom" height="5rem" />)

    const scrim = screen.getByTestId('scrim')
    expect(scrim).toHaveClass('bottom-0', 'bg-gradient-to-t')
    expect(scrim).not.toHaveClass('top-0', 'bg-gradient-to-b')
    expect(scrim.style.height).toBe('5rem')
    expect(scrim.style.maskImage).toBe('linear-gradient(to top, black 20%, transparent 100%)')
  })
})
