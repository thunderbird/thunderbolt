/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { MobileBlurBackdrop } from './mobile-blur-backdrop'

afterEach(cleanup)

describe('MobileBlurBackdrop', () => {
  it('blurs and mutes the colors behind mobile menus', () => {
    const onClick = mock()
    const { container } = render(<MobileBlurBackdrop onClick={onClick} />)
    const backdrop = container.firstElementChild

    expect(backdrop).toHaveClass('backdrop-blur-md', 'backdrop-saturate-[.25]')
    fireEvent.click(backdrop!)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
