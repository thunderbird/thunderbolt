import '@/testing-library'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { createTestProvider } from '@/test-utils/test-provider'
import { CitationBadge } from './citation-badge'
import type { CitationSource } from '@/types/citation'

const renderWithProviders = (ui: React.ReactElement) => render(ui, { wrapper: createTestProvider() })

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
      const { container } = renderWithProviders(<CitationBadge sources={mockSingleSource} />)

      expect(container.querySelector('button')?.textContent).toContain('Example Site')
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

      const { container } = renderWithProviders(<CitationBadge sources={sourceWithoutSiteName} />)

      expect(container.querySelector('button')?.textContent).toContain('Test Article')
    })

    it('renders multiple sources with primary source and count', () => {
      const { container } = renderWithProviders(<CitationBadge sources={mockMultipleSources} />)

      const button = container.querySelector('button')
      expect(button?.textContent).toContain('Primary Site')
      expect(button?.textContent).toContain('+2')
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

      const { container } = renderWithProviders(<CitationBadge sources={sourcesNoPrimary} />)

      const button = container.querySelector('button')
      expect(button?.textContent).toContain('First Site')
      expect(button?.textContent).toContain('+1')
    })

    it('returns null when sources array is empty', () => {
      const { container } = renderWithProviders(<CitationBadge sources={[]} />)

      expect(container.firstChild).toBeNull()
    })

    it('renders with aria-label for accessibility', () => {
      const { container } = renderWithProviders(<CitationBadge sources={mockSingleSource} />)

      const button = container.querySelector('button')
      expect(button?.getAttribute('aria-label')).toBe('View source: Test Article')
    })

    it('renders as button element with proper type', () => {
      const { container } = renderWithProviders(<CitationBadge sources={mockSingleSource} />)

      const button = container.querySelector('button')
      expect(button?.getAttribute('type')).toBe('button')
    })
  })

  describe('interaction', () => {
    it('is clickable', () => {
      const { container } = renderWithProviders(<CitationBadge sources={mockSingleSource} />)

      const button = container.querySelector('button')!
      expect(() => fireEvent.click(button)).not.toThrow()
    })

    it('opens popover/sheet when clicked', () => {
      const { container } = renderWithProviders(<CitationBadge sources={mockSingleSource} />)

      const button = container.querySelector('button')!
      fireEvent.click(button)

      expect(button.getAttribute('aria-expanded')).toBe('true')
    })

    it('responds to Enter key', () => {
      const { container } = renderWithProviders(<CitationBadge sources={mockSingleSource} />)

      const button = container.querySelector('button')!
      fireEvent.keyDown(button, { key: 'Enter' })

      expect(button.getAttribute('aria-expanded')).toBe('true')
    })

    it('responds to Space key', () => {
      const { container } = renderWithProviders(<CitationBadge sources={mockSingleSource} />)

      const button = container.querySelector('button')!
      fireEvent.keyDown(button, { key: ' ' })

      expect(button.getAttribute('aria-expanded')).toBe('true')
    })

    it('does not open when other keys are pressed', () => {
      const { container } = renderWithProviders(<CitationBadge sources={mockSingleSource} />)

      const button = container.querySelector('button')!
      fireEvent.keyDown(button, { key: 'a' })

      const dialog = document.querySelector('[role="dialog"]')
      expect(dialog).toBeNull()
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

      const { container } = renderWithProviders(<CitationBadge sources={incompleteSource} />)

      expect(container.querySelector('button')).toBeTruthy()
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

      const { container } = renderWithProviders(<CitationBadge sources={specialSource} />)

      expect(container.querySelector('button')?.textContent).toContain('Site & Name')
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

      const { container } = renderWithProviders(<CitationBadge sources={longNameSource} />)

      expect(container.querySelector('button')?.textContent).toContain('Very Long Site Name')
    })
  })
})
