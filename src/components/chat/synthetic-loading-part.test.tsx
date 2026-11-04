/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { SyntheticLoadingPart } from './synthetic-loading-part'

describe('SyntheticLoadingPart', () => {
  it('keeps the loading placeholder out of keyboard focus', () => {
    render(<SyntheticLoadingPart isStreaming />)

    const trigger = screen.getByRole('button')
    act(() => trigger.focus())

    expect(trigger).not.toHaveFocus()
  })
})
