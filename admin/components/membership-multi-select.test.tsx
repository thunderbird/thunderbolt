/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { MembershipMultiSelect } from './membership-multi-select'

const items = [
  { id: 'u1', label: 'Ada Lovelace', description: 'ada@example.com' },
  { id: 'u2', label: 'Grace Hopper', description: 'grace@example.com' },
]

const renderSelect = (selectedIds: string[], onChange = mock((_ids: string[]) => {})) => {
  render(
    <MembershipMultiSelect
      id="members"
      items={items}
      selectedIds={selectedIds}
      onChange={onChange}
      placeholder="Add members"
      searchPlaceholder="Search people"
      emptyMessage="Nobody matches."
      removeLabel={(label) => `Remove ${label}`}
    />,
  )
  return onChange
}

describe('MembershipMultiSelect', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows each selection as a button that removes it', () => {
    const onChange = renderSelect(['u1', 'u2'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }))
    expect(onChange).toHaveBeenCalledWith(['u2'])
  })

  it('filters the choices by search and toggles one', () => {
    const onChange = renderSelect([])
    fireEvent.click(screen.getByRole('button', { name: 'Add members' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people' }), { target: { value: 'grace' } })

    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith(['u2'])
  })

  it('searches on the server and keeps a selection the results dropped', () => {
    const onSearch = mock((_query: string) => {})
    const props = {
      id: 'members',
      selectedIds: ['u1'],
      onChange: () => {},
      placeholder: 'Add members',
      searchPlaceholder: 'Search people',
      emptyMessage: 'Nobody matches.',
      removeLabel: (label: string) => `Remove ${label}`,
      onSearch,
    }
    const { rerender } = render(<MembershipMultiSelect {...props} items={items} />)
    fireEvent.click(screen.getByRole('button', { name: '1 selected' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people' }), { target: { value: 'gra' } })
    expect(onSearch).toHaveBeenCalledWith('gra')

    rerender(<MembershipMultiSelect {...props} items={[items[1]]} />)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Remove Ada Lovelace' })).toBeInTheDocument()
  })

  it('says when nothing matches', () => {
    renderSelect([])
    fireEvent.click(screen.getByRole('button', { name: 'Add members' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people' }), { target: { value: 'zzz' } })
    expect(screen.getByText('Nobody matches.')).toBeInTheDocument()
  })
})
