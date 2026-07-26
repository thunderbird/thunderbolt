/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { SettingsListBody, SettingsListPane, SettingsPageShell, SettingsSelectableRow } from './settings-list'

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

describe('settings scroll clearance', () => {
  it('keeps mobile list content behind the edge fades with safe-area runway', () => {
    const { container } = render(
      <>
        <SettingsPageShell data-testid="page" />
        <SettingsListPane data-testid="pane">
          <SettingsListBody data-testid="body" />
        </SettingsListPane>
      </>,
    )

    expect(screen.getByTestId('page')).toHaveClass(
      'max-md:pt-[calc(var(--header-inset)+1rem)]',
      'max-md:pb-[calc(var(--touch-height-lg)+var(--page-create-action-clearance-inset,0px)+4rem)]',
    )
    expect(screen.getByTestId('pane')).toHaveClass('max-md:pb-0')
    expect(screen.getByTestId('body')).toHaveClass(
      'max-md:-mt-[var(--header-inset)]',
      'max-md:pt-[var(--header-inset)]',
      'max-md:pb-[calc(var(--touch-height-lg)+var(--page-create-action-clearance-inset,0px)+4rem)]',
    )
    expect(container).toBeInTheDocument()
  })
})
