/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { SearchableMenu } from './searchable-menu'
import type { SearchableMenuItem } from './types'

const mockFlatItems: SearchableMenuItem[] = [
  { id: '1', label: 'Option 1', description: 'First option' },
  { id: '2', label: 'Option 2', description: 'Second option' },
  { id: '3', label: 'Option 3', disabled: true },
]

// Desktop is happy-dom's default viewport; mobile tests narrow it and restore.
describe('SearchableMenu', () => {
  afterEach(() => {
    cleanup()
    restoreViewport()
  })

  describe('functionality', () => {
    it('calls onValueChange when item is selected', () => {
      const handleChange = mock()
      render(<SearchableMenu items={mockFlatItems} onValueChange={handleChange} open={true} onOpenChange={() => {}} />)

      fireEvent.click(screen.getByText('Option 2'))
      expect(handleChange).toHaveBeenCalledWith('2', mockFlatItems[1])
    })

    it('filters items based on search query', () => {
      render(<SearchableMenu items={mockFlatItems} onValueChange={() => {}} open={true} onOpenChange={() => {}} />)

      const searchInput = screen.getByPlaceholderText('Search…')
      fireEvent.change(searchInput, { target: { value: 'Option 1' } })

      expect(screen.getByText('Option 1')).toBeInTheDocument()
      expect(screen.queryByText('Option 2')).not.toBeInTheDocument()
    })

    it('filters items by description', () => {
      render(<SearchableMenu items={mockFlatItems} onValueChange={() => {}} open={true} onOpenChange={() => {}} />)

      const searchInput = screen.getByPlaceholderText('Search…')
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

    it('closes before running a footer action', () => {
      const expandedStates: Array<string | null> = []
      render(
        <SearchableMenu
          items={mockFlatItems}
          onValueChange={() => {}}
          footerAction={{
            label: 'Add option',
            onAction: () => {
              expandedStates.push(screen.getByRole('button', { name: /select/i }).getAttribute('aria-expanded'))
            },
          }}
        />,
      )

      const trigger = screen.getByRole('button', { name: /select/i })
      fireEvent.click(trigger)
      fireEvent.click(screen.getByRole('button', { name: 'Add option' }))

      expect(expandedStates).toEqual(['false'])
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
    })
  })

  describe('mobile', () => {
    it('renders as a card drawer with a dialog trigger', () => {
      forceMobileViewport()
      render(
        <SearchableMenu
          items={mockFlatItems}
          onValueChange={() => {}}
          open
          onOpenChange={() => {}}
          mobileTitle="Choose an option"
        />,
      )

      const trigger = document.querySelector('button[aria-haspopup="dialog"]')
      expect(trigger).toBeInTheDocument()
      expect(trigger).toHaveAttribute('aria-expanded', 'true')

      const drawer = screen
        .getByText('Choose an option', { selector: '[data-slot="drawer-title"]' })
        .closest('[data-slot="drawer-content"]')
      expect(drawer).toHaveAttribute('data-swipe-direction', 'down')
    })

    it('selects items from the drawer list', () => {
      forceMobileViewport()
      const handleChange = mock()
      render(
        <SearchableMenu
          items={mockFlatItems}
          onValueChange={handleChange}
          open
          onOpenChange={() => {}}
          mobileTitle="Choose an option"
        />,
      )

      fireEvent.click(screen.getByText('Option 2'))
      expect(handleChange).toHaveBeenCalledWith('2', mockFlatItems[1])
    })
  })
})
