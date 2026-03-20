import '@/testing-library'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import type { CitationSource } from '@/types/citation'
import { ExternalLinkDialogProvider } from './markdown-utils'
import { SourceCard } from './source-card'
import { type ReactElement } from 'react'

const renderWithProvider = (ui: ReactElement) =>
  render(ui, { wrapper: ({ children }) => <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider> })

describe('SourceCard', () => {
  const mockSource: CitationSource = {
    id: '1',
    title: 'Example Article Title',
    url: 'https://example.com/article',
    siteName: 'Example Site',
    favicon: 'https://example.com/favicon.ico',
  }

  describe('rendering', () => {
    it('should display title and site name', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      expect(screen.getByText('Example Article Title')).toBeInTheDocument()
      expect(screen.getByText('Example Site')).toBeInTheDocument()

      const link = screen.getByRole('listitem')
      const img = link.querySelector('img')
      expect(img).toHaveAttribute('src', 'https://example.com/favicon.ico')
    })

    it('should show URL as title when title is missing', () => {
      const sourceWithoutTitle = { ...mockSource, title: '' }
      renderWithProvider(<SourceCard source={sourceWithoutTitle} />)

      expect(screen.getByText('https://example.com/article')).toBeInTheDocument()
    })

    it('should derive favicon from URL when favicon prop is missing', () => {
      const sourceWithoutFavicon = { ...mockSource, favicon: undefined }
      renderWithProvider(<SourceCard source={sourceWithoutFavicon} />)

      const container = screen.getByRole('listitem')

      // Without proxyBase, derives favicon directly from the domain origin
      const img = container.querySelector('img')
      expect(img).toBeInTheDocument()
      expect(img).toHaveAttribute('src', 'https://example.com/favicon.ico')
    })

    it('should use proxied favicon URL when proxyBase is provided', () => {
      const sourceWithoutFavicon = { ...mockSource, favicon: undefined }
      renderWithProvider(<SourceCard source={sourceWithoutFavicon} proxyBase="http://localhost:8000/v1" />)

      const container = screen.getByRole('listitem')
      const img = container.querySelector('img')
      expect(img).toBeInTheDocument()
      expect(img).toHaveAttribute(
        'src',
        'http://localhost:8000/v1/pro/proxy/' + encodeURIComponent('https://example.com/favicon.ico'),
      )
    })

    it('should show initial badge when favicon fails to load', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const container = screen.getByRole('listitem')
      const img = container.querySelector('img')
      expect(img).toBeInTheDocument()

      // Trigger error event
      fireEvent.error(img!)

      // After error, initial badge should be shown
      const badge = container.querySelector('[aria-hidden="true"]')
      expect(badge).toBeInTheDocument()
      expect(badge).toHaveTextContent('E')
    })

    it('should display "Unknown" when site name is missing', () => {
      const sourceWithoutSiteName = { ...mockSource, siteName: undefined }
      renderWithProvider(<SourceCard source={sourceWithoutSiteName} />)

      expect(screen.getByText('Unknown')).toBeInTheDocument()
    })
  })

  describe('link behavior', () => {
    it('should use actual URL as href and show warning dialog on click', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const link = screen.getByRole('listitem')
      expect(link).toHaveAttribute('href', 'https://example.com/article')
      expect(link.tagName).toBe('A')
    })

    it('should show external link dialog when clicked', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const link = screen.getByRole('listitem')
      fireEvent.click(link)

      // Dialog should appear with the URL
      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
      expect(screen.getByText('Open External Link')).toBeInTheDocument()
      expect(screen.getByText('https://example.com/article')).toBeInTheDocument()
    })

    it('should open URL in new window when dialog is confirmed', () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => ({}) as Window)
      window.open = mockWindowOpen as typeof window.open

      renderWithProvider(<SourceCard source={mockSource} />)

      const link = screen.getByRole('listitem')
      fireEvent.click(link)

      const openButton = screen.getByRole('button', { name: 'Open Link' })
      fireEvent.click(openButton)

      expect(mockWindowOpen).toHaveBeenCalledWith('https://example.com/article', '_blank', 'noopener,noreferrer')

      window.open = originalOpen
    })

    it('should not open URL when dialog is cancelled', () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => null)
      window.open = mockWindowOpen as typeof window.open

      renderWithProvider(<SourceCard source={mockSource} />)

      const link = screen.getByRole('listitem')
      fireEvent.click(link)

      const closeButton = screen.getByRole('button', { name: 'Close' })
      fireEvent.click(closeButton)

      expect(mockWindowOpen).not.toHaveBeenCalled()

      window.open = originalOpen
    })
  })

  describe('accessibility', () => {
    it('should have listitem role for screen readers', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const link = screen.getByRole('listitem')
      expect(link).toBeInTheDocument()
    })

    it('should have empty alt text on favicon', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const link = screen.getByRole('listitem')
      const img = link.querySelector('img')
      expect(img).toHaveAttribute('alt', '')
    })

    it('should show initial badge with aria-hidden when derived favicon fails', () => {
      const sourceWithoutFavicon = { ...mockSource, favicon: undefined }
      renderWithProvider(<SourceCard source={sourceWithoutFavicon} />)

      const link = screen.getByRole('listitem')
      const img = link.querySelector('img')
      expect(img).toBeInTheDocument()

      // Trigger error on derived favicon
      fireEvent.error(img!)

      const badge = link.querySelector('[aria-hidden="true"]')
      expect(badge).toBeInTheDocument()
    })
  })

  describe('styling', () => {
    it('should apply custom className', () => {
      renderWithProvider(<SourceCard source={mockSource} className="custom-class" />)

      const link = screen.getByRole('listitem')
      expect(link).toHaveClass('custom-class')
    })

    it('should have proper link styling', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const link = screen.getByRole('listitem')
      expect(link).toHaveClass('flex')
      expect(link).toHaveClass('flex-col')
      expect(link).toHaveClass('cursor-pointer')
    })

    it('should display colored badge when derived favicon fails to load', () => {
      const sourceWithoutFavicon = { ...mockSource, favicon: undefined, siteName: 'Apple' }
      const { container } = renderWithProvider(<SourceCard source={sourceWithoutFavicon} />)

      // Trigger favicon error to fall back to letter badge
      const img = container.querySelector('img')
      fireEvent.error(img!)

      const badge = container.querySelector('[aria-hidden="true"]')
      expect(badge).toBeTruthy()
      expect(badge?.classList.toString()).toContain('bg-')
    })
  })
})
