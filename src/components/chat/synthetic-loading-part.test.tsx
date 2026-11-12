/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { SyntheticLoadingPart } from './synthetic-loading-part'

describe('SyntheticLoadingPart', () => {
  it('announces activity without pretending to be an interactive accordion', () => {
    const { rerender } = render(<SyntheticLoadingPart isStreaming />)
    expect(screen.getByRole('status')).toHaveTextContent('Working…')
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<SyntheticLoadingPart isStreaming={false} />)
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
  })
})
