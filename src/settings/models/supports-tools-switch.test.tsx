/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { SupportsToolsSwitch } from './supports-tools-switch'

describe('SupportsToolsSwitch', () => {
  afterEach(() => {
    cleanup()
  })

  it('reports a toggle when enabled', () => {
    const onCheckedChange = mock(() => {})
    render(<SupportsToolsSwitch checked onCheckedChange={onCheckedChange} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Supports tools' }))

    expect(onCheckedChange).toHaveBeenCalledWith(false)
  })

  it('ignores clicks while a connection test runs', () => {
    const onCheckedChange = mock(() => {})
    render(<SupportsToolsSwitch checked onCheckedChange={onCheckedChange} disabled />)

    const toggle = screen.getByRole('switch', { name: 'Supports tools' })
    fireEvent.click(toggle)

    expect(toggle).toBeDisabled()
    expect(onCheckedChange).not.toHaveBeenCalled()
  })
})
