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
        trailing={<button onClick={onTrailing}>Toggle</button>}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
    expect(onTrailing).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Example' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})

it('names the row button from its visible title and subtitle, visible text first', () => {
  render(<SettingsSelectableRow title="Example" subtitle="Details" onSelect={() => {}} />)
  expect(screen.getByRole('button', { name: 'Example Details' })).toBeInTheDocument()
})

describe('SettingsSelectableRow reflow', () => {
  it('wraps long titles and subtitles below md and truncates from md up', () => {
    render(<SettingsSelectableRow title="A long title" subtitle="A long subtitle" onSelect={() => {}} />)

    expect(screen.getByText('A long title')).toHaveClass('max-md:break-words', 'md:truncate')
    expect(screen.getByText('A long subtitle')).toHaveClass('max-md:break-words', 'md:truncate')
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

it('opens Edit and Remove without selecting the row and respects protected items', async () => {
  const onEdit = mock(() => {})
  const onRemove = mock(() => {})
  const onSelect = mock(() => {})
  render(<SettingsSelectableRow title="Account" onSelect={onSelect} contextMenu={{ onEdit, onRemove }} />)
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Account' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }))
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Account' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
  expect(onRemove).toHaveBeenCalledTimes(1)
  expect(onSelect).not.toHaveBeenCalled()
  cleanup()
  render(<SettingsSelectableRow title="Built in" onSelect={onSelect} contextMenu={{}} />)
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Built in' }))
  expect(await screen.findByRole('menuitem', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('menuitem', { name: 'Remove' })).toHaveAttribute('aria-disabled', 'true')
})
