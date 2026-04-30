/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { SearchableMenu } from './searchable-menu'
import type { SearchableMenuItem } from './types'

// Mock useIsMobile hook
mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => ({ isMobile: false }),
}))

const mockFlatItems: SearchableMenuItem[] = [
  { id: '1', label: 'Option 1', description: 'First option' },
  { id: '2', label: 'Option 2', description: 'Second option' },
  { id: '3', label: 'Option 3', disabled: true },
]

describe('SearchableMenu', () => {
  describe('functionality', () => {
    it('calls onValueChange when item is selected', () => {
      const handleChange = mock()
      render(<SearchableMenu items={mockFlatItems} onValueChange={handleChange} open={true} onOpenChange={() => {}} />)

      fireEvent.click(screen.getByText('Option 2'))
      expect(handleChange).toHaveBeenCalledWith('2', mockFlatItems[1])
    })

    it('filters items based on search query', () => {
      render(<SearchableMenu items={mockFlatItems} onValueChange={() => {}} open={true} onOpenChange={() => {}} />)

      const searchInput = screen.getByPlaceholderText('Search...')
      fireEvent.change(searchInput, { target: { value: 'Option 1' } })

      expect(screen.getByText('Option 1')).toBeInTheDocument()
      expect(screen.queryByText('Option 2')).not.toBeInTheDocument()
    })

    it('filters items by description', () => {
      render(<SearchableMenu items={mockFlatItems} onValueChange={() => {}} open={true} onOpenChange={() => {}} />)

      const searchInput = screen.getByPlaceholderText('Search...')
      fireEvent.change(searchInput, { target: { value: 'Second' } })

      expect(screen.getByText('Option 2')).toBeInTheDocument()
      expect(screen.queryByText('Option 1')).not.toBeInTheDocument()
    })

    it('does not allow selecting disabled items', () => {
      const handleChange = mock()
      render(<SearchableMenu items={mockFlatItems} onValueChange={handleChange} open={true} onOpenChange={() => {}} />)

      const disabledButton = screen.getByText('Option 3').closest('button')
      expect(disabledButton).toBeDisabled()
    })
  })
})
