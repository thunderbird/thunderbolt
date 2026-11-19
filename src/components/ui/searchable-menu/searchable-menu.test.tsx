/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { desktopWidth, forceMobileViewport, mobileWidth, restoreViewport, setViewport } from '@/test-utils/viewport'
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
    it('labels search and preserves the reason a filtered group is unavailable', () => {
      render(
        <SearchableMenu
          embedded
          onValueChange={() => {}}
          items={[
            { id: 'available', items: [{ id: 'public', label: 'Public model' }] },
            {
              id: 'private',
              label: 'Only available in private chats.',
              items: [{ id: 'private-model', label: 'Private model', disabled: true }],
            },
          ]}
        />,
      )
      fireEvent.change(screen.getByRole('textbox', { name: 'Search…' }), { target: { value: '  private  ' } })
      expect(screen.getByRole('heading', { name: 'Only available in private chats.' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Private model' })).toBeDisabled()
      expect(screen.queryByText('Public model')).toBeNull()
    })

    it('exposes selection to assistive technology for default and custom rows', () => {
      const view = render(<SearchableMenu embedded items={mockFlatItems} value="2" onValueChange={() => {}} />)
      expect(screen.getByRole('button', { name: /Option 2/ })).toHaveAttribute('aria-current', 'true')
      expect(screen.getByRole('button', { name: /Option 1/ })).not.toHaveAttribute('aria-current')
      view.rerender(
        <SearchableMenu
          embedded
          items={mockFlatItems}
          value="1"
          onValueChange={() => {}}
          renderItem={(item) => <span>{item.label}</span>}
        />,
      )
      expect(screen.getByRole('button', { name: 'Option 1' })).toHaveAttribute('aria-current', 'true')
    })

    it('keeps an embedded list open on selection and closes its host before a footer action', () => {
      const onChange = mock()
      const events: string[] = []
      render(
        <SearchableMenu
          embedded
          items={mockFlatItems}
          onValueChange={onChange}
          onOpenChange={(open) => {
            if (!open) {
              events.push('close')
            }
          }}
          footerAction={{ label: 'Add option', onAction: () => events.push('add') }}
        />,
      )
      expect(screen.queryByRole('dialog')).toBeNull()
      fireEvent.click(screen.getByText('Option 2'))
      expect(onChange).toHaveBeenCalledWith('2', mockFlatItems[1])
      expect(events).toEqual([])
      expect(screen.getByText('Option 1')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Add option' }))
      expect(events).toEqual(['close', 'add'])
    })

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

    it.each([desktopWidth, mobileWidth])('closes before running a footer action at %dpx', (width) => {
      setViewport(width)
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

    it('moves focus from the trigger to the drawer without focusing the search field', async () => {
      forceMobileViewport()
      const renderMenu = (open: boolean) => (
        <SearchableMenu items={mockFlatItems} onValueChange={() => {}} open={open} onOpenChange={() => {}} />
      )
      const { rerender } = render(renderMenu(false))
      const trigger = document.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement
      act(() => trigger.focus())

      rerender(renderMenu(true))
      await act(() => getClock().runAllAsync())

      // The open drawer hides the rest of the page, including the trigger, from screen readers.
      expect(trigger.closest('[aria-hidden="true"]')).not.toBeNull()
      expect(document.activeElement?.getAttribute('data-slot')).toBe('drawer-content')
      expect(screen.getByPlaceholderText('Search…')).not.toHaveFocus()
    })
  })
})
