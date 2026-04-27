/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { Combobox, type ComboboxItem } from './combobox'

const mockItems: ComboboxItem[] = [
  { id: 'apple', label: 'Apple' },
  { id: 'banana', label: 'Banana', description: 'A yellow fruit' },
  { id: 'cherry', label: 'Cherry', disabled: true },
]

describe('Combobox', () => {
  describe('rendering', () => {
    it('shows placeholder when no value is selected', () => {
      render(<Combobox items={mockItems} onValueChange={() => {}} placeholder="Pick a fruit" />)
      expect(screen.getByRole('combobox')).toHaveTextContent('Pick a fruit')
    })

    it('shows selected item label when value is set', () => {
      render(<Combobox items={mockItems} value="banana" onValueChange={() => {}} />)
      expect(screen.getByRole('combobox')).toHaveTextContent('Banana')
    })

    it('shows displayValue when provided', () => {
      render(<Combobox items={mockItems} onValueChange={() => {}} displayValue="Custom Label" />)
      expect(screen.getByRole('combobox')).toHaveTextContent('Custom Label')
    })

    it('disables the trigger when disabled', () => {
      render(<Combobox items={mockItems} onValueChange={() => {}} disabled />)
      expect(screen.getByRole('combobox')).toBeDisabled()
    })
  })

  describe('open/close', () => {
    it('supports controlled open state', () => {
      const handleOpenChange = mock()
      render(<Combobox items={mockItems} onValueChange={() => {}} open={true} onOpenChange={handleOpenChange} />)
      // When open, the search input should be visible
      expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument()
    })

    it('calls onOpenChange when trigger is clicked', () => {
      const handleOpenChange = mock()
      render(<Combobox items={mockItems} onValueChange={() => {}} open={false} onOpenChange={handleOpenChange} />)
      fireEvent.click(screen.getByRole('combobox'))
      expect(handleOpenChange).toHaveBeenCalledWith(true)
    })
  })

  describe('selection', () => {
    it('calls onValueChange when an item is selected', () => {
      const handleChange = mock()
      render(<Combobox items={mockItems} onValueChange={handleChange} open={true} onOpenChange={() => {}} />)
      fireEvent.click(screen.getByText('Apple'))
      expect(handleChange).toHaveBeenCalledWith('apple')
    })
  })

  describe('loading', () => {
    it('shows spinner in search input when loading', () => {
      render(<Combobox items={[]} onValueChange={() => {}} open={true} onOpenChange={() => {}} loading />)
      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })

    it('keeps items visible while loading', () => {
      render(<Combobox items={mockItems} onValueChange={() => {}} open={true} onOpenChange={() => {}} loading />)
      expect(screen.getByText('Apple')).toBeInTheDocument()
    })

    it('hides empty message while loading', () => {
      render(
        <Combobox
          items={[]}
          onValueChange={() => {}}
          open={true}
          onOpenChange={() => {}}
          loading
          emptyMessage="No results"
        />,
      )
      expect(screen.queryByText('No results')).not.toBeInTheDocument()
    })
  })

  describe('async search', () => {
    it('calls onSearchChange when typing in async mode', () => {
      const handleSearchChange = mock()
      render(
        <Combobox
          items={[]}
          onValueChange={() => {}}
          open={true}
          onOpenChange={() => {}}
          searchValue=""
          onSearchChange={handleSearchChange}
        />,
      )
      const input = screen.getByPlaceholderText('Search...')
      fireEvent.change(input, { target: { value: 'test' } })
      expect(handleSearchChange).toHaveBeenCalledWith('test')
    })

    it('uses controlled searchValue in async mode', () => {
      render(
        <Combobox
          items={[]}
          onValueChange={() => {}}
          open={true}
          onOpenChange={() => {}}
          searchValue="hello"
          onSearchChange={() => {}}
        />,
      )
      const input = screen.getByPlaceholderText('Search...')
      expect(input).toHaveValue('hello')
    })
  })

  describe('item features', () => {
    it('renders item descriptions', () => {
      render(<Combobox items={mockItems} onValueChange={() => {}} open={true} onOpenChange={() => {}} />)
      expect(screen.getByText('A yellow fruit')).toBeInTheDocument()
    })

    it('renders item icons', () => {
      const itemsWithIcon: ComboboxItem[] = [
        { id: 'star', label: 'Star', icon: <span data-testid="star-icon">*</span> },
      ]
      render(<Combobox items={itemsWithIcon} onValueChange={() => {}} open={true} onOpenChange={() => {}} />)
      expect(screen.getByTestId('star-icon')).toBeInTheDocument()
    })
  })
})
