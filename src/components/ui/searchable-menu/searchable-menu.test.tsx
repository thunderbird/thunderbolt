import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { SearchableMenu } from './searchable-menu'
import type { SearchableMenuGroup, SearchableMenuItem } from './types'

// Mock useIsMobile hook
mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => ({ isMobile: false }),
}))

const mockFlatItems: SearchableMenuItem[] = [
  { id: '1', label: 'Option 1', description: 'First option' },
  { id: '2', label: 'Option 2', description: 'Second option' },
  { id: '3', label: 'Option 3', disabled: true },
]

const mockGroupedItems: SearchableMenuGroup[] = [
  {
    id: 'group-1',
    label: 'Group A',
    items: [
      { id: 'a1', label: 'Alpha', description: 'First in group A' },
      { id: 'a2', label: 'Beta', description: 'Second in group A' },
    ],
  },
  {
    id: 'group-2',
    label: 'Group B',
    items: [{ id: 'b1', label: 'Gamma', description: 'First in group B' }],
  },
]

/**
 * Helper to get the popover content from the portal.
 * Radix UI renders popovers outside the container in a portal.
 */
const getPopoverContent = () => document.querySelector('[data-slot="popover-content"]')

/**
 * Helper to normalize HTML by removing dynamic Radix IDs that change between test runs.
 */
const normalizeHtml = (html: string) =>
  html.replace(/radix-[^"]+/g, 'radix-ID').replace(/aria-controls="[^"]+"/g, 'aria-controls="radix-ID"')

describe('SearchableMenu', () => {
  describe('trigger snapshots', () => {
    it('renders trigger with no selection', () => {
      const { container } = render(<SearchableMenu items={mockFlatItems} onValueChange={() => {}} />)
      expect(normalizeHtml(container.innerHTML)).toMatchSnapshot()
    })

    it('renders trigger with selected item', () => {
      const { container } = render(<SearchableMenu items={mockFlatItems} value="1" onValueChange={() => {}} />)
      expect(normalizeHtml(container.innerHTML)).toMatchSnapshot()
    })
  })

  describe('popover content snapshots', () => {
    it('renders popover with flat items', () => {
      render(<SearchableMenu items={mockFlatItems} value="1" onValueChange={() => {}} open onOpenChange={() => {}} />)
      const popover = getPopoverContent()
      expect(popover?.innerHTML).toMatchSnapshot()
    })

    it('renders popover with grouped items', () => {
      render(
        <SearchableMenu items={mockGroupedItems} value="a1" onValueChange={() => {}} open onOpenChange={() => {}} />,
      )
      const popover = getPopoverContent()
      expect(popover?.innerHTML).toMatchSnapshot()
    })

    it('renders popover without search input when searchable is false', () => {
      render(
        <SearchableMenu
          items={mockFlatItems}
          onValueChange={() => {}}
          searchable={false}
          open
          onOpenChange={() => {}}
        />,
      )
      const popover = getPopoverContent()
      expect(popover?.innerHTML).toMatchSnapshot()
    })

    it('renders popover with footer', () => {
      render(
        <SearchableMenu
          items={mockFlatItems}
          onValueChange={() => {}}
          open
          onOpenChange={() => {}}
          footer={<button type="button">Add Item</button>}
        />,
      )
      const popover = getPopoverContent()
      expect(popover?.innerHTML).toMatchSnapshot()
    })

    it('renders empty state when no items', () => {
      render(
        <SearchableMenu items={[]} onValueChange={() => {}} open onOpenChange={() => {}} emptyMessage="No results" />,
      )
      const popover = getPopoverContent()
      expect(popover?.innerHTML).toMatchSnapshot()
    })
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
