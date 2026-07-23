/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { SettingsSelectableRow } from './settings-list'

afterEach(cleanup)

describe('SettingsSelectableRow', () => {
  it('keeps trailing controls outside the row selection button', () => {
    const onSelect = mock(() => {})
    const onTrailing = mock(() => {})
    render(
      <SettingsSelectableRow
        title="Example"
        onSelect={onSelect}
        ariaLabel="Open Example"
        trailing={<button onClick={onTrailing}>Toggle</button>}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
    expect(onTrailing).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open Example' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
