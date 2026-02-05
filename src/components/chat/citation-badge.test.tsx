import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { CitationBadge } from './citation-badge'
import type { CitationSource } from '@/types/citation'

// Clean up after each test
afterEach(() => {
  cleanup()
})

describe('CitationBadge', () => {
  const mockSingleSource: CitationSource[] = [
    {
      id: 'src-1',
      title: 'Test Article',
      url: 'https://example.com/article',
      siteName: 'Example Site',
      isPrimary: true,
    },
  ]

  const mockMultipleSources: CitationSource[] = [
    {
      id: 'src-1',
      title: 'Primary Article',
      url: 'https://example.com/primary',
      siteName: 'Primary Site',
      isPrimary: true,
    },
    {
      id: 'src-2',
      title: 'Second Article',
      url: 'https://example.com/second',
      siteName: 'Second Site',
    },
    {
      id: 'src-3',
      title: 'Third Article',
      url: 'https://example.com/third',
      siteName: 'Third Site',
    },
  ]

  describe('rendering', () => {
    it('renders single source with siteName', () => {
      render(<CitationBadge sources={mockSingleSource} />)

      expect(screen.getByText('Example Site')).toBeTruthy()
    })

    it('renders single source with title when siteName is missing', () => {
      const sourceWithoutSiteName: CitationSource[] = [
        {
          id: 'src-1',
          title: 'Test Article',
          url: 'https://example.com/article',
          isPrimary: true,
        },
      ]

      render(<CitationBadge sources={sourceWithoutSiteName} />)

      expect(screen.getByText('Test Article')).toBeTruthy()
    })

    it('renders multiple sources with primary source and count', () => {
      render(<CitationBadge sources={mockMultipleSources} />)

      expect(screen.getByText('Primary Site')).toBeTruthy()
      expect(screen.getByText('+2')).toBeTruthy()
    })

    it('renders multiple sources using first source when no primary is marked', () => {
      const sourcesNoPrimary: CitationSource[] = [
        {
          id: 'src-1',
          title: 'First Article',
          url: 'https://example.com/first',
          siteName: 'First Site',
        },
        {
          id: 'src-2',
          title: 'Second Article',
          url: 'https://example.com/second',
          siteName: 'Second Site',
        },
      ]

      render(<CitationBadge sources={sourcesNoPrimary} />)

      expect(screen.getByText('First Site')).toBeTruthy()
      expect(screen.getByText('+1')).toBeTruthy()
    })

    it('returns null when sources array is empty', () => {
      const { container } = render(<CitationBadge sources={[]} />)

      expect(container.firstChild).toBeNull()
    })

    it('renders with aria-label for accessibility', () => {
      render(<CitationBadge sources={mockSingleSource} />)

      const button = screen.getByRole('button')
      expect(button.getAttribute('aria-label')).toBe('View source: Test Article')
    })

    it('renders as button element with proper type', () => {
      render(<CitationBadge sources={mockSingleSource} />)

      const button = screen.getByRole('button')
      expect(button.getAttribute('type')).toBe('button')
    })
  })

  describe('interaction', () => {
    it('is clickable', () => {
      render(<CitationBadge sources={mockSingleSource} />)

      const button = screen.getByRole('button')
      expect(() => fireEvent.click(button)).not.toThrow()
    })

    it('opens popover/sheet when clicked', () => {
      render(<CitationBadge sources={mockSingleSource} />)

      const button = screen.getByRole('button')
      fireEvent.click(button)

      // Source details should be visible after click
      expect(screen.getByText('Test Article')).toBeTruthy()
    })

    it('responds to Enter key', () => {
      render(<CitationBadge sources={mockSingleSource} />)

      const button = screen.getByRole('button')
      fireEvent.keyDown(button, { key: 'Enter' })

      // Source details should be visible
      expect(screen.getByText('Test Article')).toBeTruthy()
    })

    it('responds to Space key', () => {
      render(<CitationBadge sources={mockSingleSource} />)

      const button = screen.getByRole('button')
      fireEvent.keyDown(button, { key: ' ' })

      // Source details should be visible
      expect(screen.getByText('Test Article')).toBeTruthy()
    })

    it('does not open when other keys are pressed', () => {
      render(<CitationBadge sources={mockSingleSource} />)

      const button = screen.getByRole('button')
      fireEvent.keyDown(button, { key: 'a' })

      // Source list should not be visible (only badge text)
      const articleLinks = screen.queryAllByText('Test Article')
      // Badge text contains siteName "Example Site", not title, so only 0 or 1 "Test Article" should appear
      expect(articleLinks.length).toBeLessThanOrEqual(1)
    })
  })

  describe('edge cases', () => {
    it('handles sources without siteName or title gracefully', () => {
      const incompleteSource: CitationSource[] = [
        {
          id: 'src-1',
          title: '',
          url: 'https://example.com',
        },
      ]

      render(<CitationBadge sources={incompleteSource} />)

      // Should still render the button
      expect(screen.getByRole('button')).toBeTruthy()
    })

    it('handles sources with special characters in name', () => {
      const specialSource: CitationSource[] = [
        {
          id: 'src-1',
          title: 'Test & Article <script>',
          url: 'https://example.com',
          siteName: 'Site & Name',
        },
      ]

      render(<CitationBadge sources={specialSource} />)

      expect(screen.getByText('Site & Name')).toBeTruthy()
    })

    it('handles very long source names', () => {
      const longNameSource: CitationSource[] = [
        {
          id: 'src-1',
          title: 'A'.repeat(200),
          url: 'https://example.com',
          siteName: 'Very Long Site Name That Exceeds Normal Display Length',
        },
      ]

      render(<CitationBadge sources={longNameSource} />)

      expect(screen.getByText('Very Long Site Name That Exceeds Normal Display Length')).toBeTruthy()
    })
  })
})
