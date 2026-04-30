/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import type { CitationSource } from '@/types/citation'
import { ExternalLinkDialogProvider } from './markdown-utils'
import { SourceList } from './source-list'
import { type ReactElement } from 'react'

const renderWithProvider = (ui: ReactElement) =>
  render(ui, { wrapper: ({ children }) => <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider> })

describe('SourceList', () => {
  const mockSources: CitationSource[] = [
    {
      id: '1',
      title: 'First Article',
      url: 'https://example.com/first',
      siteName: 'Example Site',
      favicon: 'https://example.com/favicon1.ico',
    },
    {
      id: '2',
      title: 'Second Article',
      url: 'https://example.com/second',
      siteName: 'Another Site',
      favicon: 'https://example.com/favicon2.ico',
    },
    {
      id: '3',
      title: 'Third Article',
      url: 'https://example.com/third',
      siteName: 'Third Site',
      favicon: 'https://example.com/favicon3.ico',
      isPrimary: true,
    },
  ]

  describe('rendering', () => {
    it('should render multiple SourceCard components', () => {
      renderWithProvider(<SourceList sources={mockSources} />)

      expect(screen.getByText('First Article')).toBeInTheDocument()
      expect(screen.getByText('Second Article')).toBeInTheDocument()
      expect(screen.getByText('Third Article')).toBeInTheDocument()

      // Should have 3 list items
      const listItems = screen.getAllByRole('listitem')
      expect(listItems).toHaveLength(3)
    })

    it('should display primary source first', () => {
      renderWithProvider(<SourceList sources={mockSources} />)

      const listItems = screen.getAllByRole('listitem')
      // Primary source (id: '3') should be first
      expect(listItems[0]).toHaveTextContent('Third Article')
    })

    it('should render single source without error', () => {
      const singleSource = [mockSources[0]]
      renderWithProvider(<SourceList sources={singleSource} />)

      expect(screen.getByText('First Article')).toBeInTheDocument()

      const listItems = screen.getAllByRole('listitem')
      expect(listItems).toHaveLength(1)
    })

    it('should handle empty sources array gracefully', () => {
      renderWithProvider(<SourceList sources={[]} />)

      expect(screen.getByText('No sources available')).toBeInTheDocument()

      // Should not have any list items
      const listItems = screen.queryAllByRole('listitem')
      expect(listItems).toHaveLength(0)
    })

    it('should render separators between items', () => {
      const { container } = renderWithProvider(<SourceList sources={mockSources} />)

      // Should have N-1 separators for N items (2 separators for 3 items)
      const separators = container.querySelectorAll('[data-slot="separator-root"]')
      expect(separators).toHaveLength(2)
    })

    it('should not render separator after last item', () => {
      const { container } = renderWithProvider(<SourceList sources={[mockSources[0]]} />)

      // Single item should have no separators
      const separators = container.querySelectorAll('[data-slot="separator-root"]')
      expect(separators).toHaveLength(0)
    })
  })

  describe('ordering', () => {
    it('should maintain order of non-primary sources', () => {
      const sources = [
        { ...mockSources[0], isPrimary: false },
        { ...mockSources[1], isPrimary: false },
        { ...mockSources[2], isPrimary: true },
      ]

      renderWithProvider(<SourceList sources={sources} />)

      const listItems = screen.getAllByRole('listitem')
      // Primary first
      expect(listItems[0]).toHaveTextContent('Third Article')
      // Then first and second in original order
      expect(listItems[1]).toHaveTextContent('First Article')
      expect(listItems[2]).toHaveTextContent('Second Article')
    })

    it('should handle multiple primary sources', () => {
      const sources = [
        { ...mockSources[0], isPrimary: false },
        { ...mockSources[1], isPrimary: true },
        { ...mockSources[2], isPrimary: false, title: 'Modified Third' },
      ]

      renderWithProvider(<SourceList sources={sources} />)

      const listItems = screen.getAllByRole('listitem')
      // Primary source should come first
      expect(listItems[0]).toHaveTextContent('Second Article')
      // Non-primary sources follow
      expect(listItems[1]).toHaveTextContent('First Article')
      expect(listItems[2]).toHaveTextContent('Modified Third')
    })

    it('should handle no primary sources', () => {
      const sources = mockSources.map((s) => ({ ...s, isPrimary: false }))

      renderWithProvider(<SourceList sources={sources} />)

      const listItems = screen.getAllByRole('listitem')
      // Should maintain original order
      expect(listItems[0]).toHaveTextContent('First Article')
      expect(listItems[1]).toHaveTextContent('Second Article')
      expect(listItems[2]).toHaveTextContent('Third Article')
    })
  })

  describe('accessibility', () => {
    it('should have list role', () => {
      renderWithProvider(<SourceList sources={mockSources} />)

      const list = screen.getByRole('list')
      expect(list).toBeInTheDocument()
    })

    it('should have proper ARIA structure', () => {
      renderWithProvider(<SourceList sources={mockSources} />)

      const list = screen.getByRole('list')
      const listItems = screen.getAllByRole('listitem')

      expect(list).toBeInTheDocument()
      expect(listItems).toHaveLength(3)
    })
  })

  describe('styling', () => {
    it('should apply custom className', () => {
      renderWithProvider(<SourceList sources={mockSources} className="custom-class" />)

      const list = screen.getByRole('list')
      expect(list).toHaveClass('custom-class')
    })

    it('should have container styling', () => {
      renderWithProvider(<SourceList sources={mockSources} />)

      const list = screen.getByRole('list')
      expect(list).toHaveClass('overflow-hidden')
    })
  })

  describe('edge cases', () => {
    it('should handle sources with missing metadata', () => {
      const sourcesWithMissing: CitationSource[] = [
        {
          id: '1',
          title: '',
          url: 'https://example.com/first',
        },
      ]

      renderWithProvider(<SourceList sources={sourcesWithMissing} />)

      // URL should be displayed as title
      expect(screen.getByText('https://example.com/first')).toBeInTheDocument()
      // Unknown site name should be shown
      expect(screen.getByText('Unknown')).toBeInTheDocument()
    })

    it('should handle many sources without performance issues', () => {
      const manySources = Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        title: `Article ${i}`,
        url: `https://example.com/${i}`,
        siteName: `Site ${i}`,
      }))

      renderWithProvider(<SourceList sources={manySources} />)

      const listItems = screen.getAllByRole('listitem')
      expect(listItems).toHaveLength(20)

      // Should have 19 separators for 20 items
      const { container } = renderWithProvider(<SourceList sources={manySources} />)
      const separators = container.querySelectorAll('[data-slot="separator-root"]')
      expect(separators).toHaveLength(19)
    })
  })
})
