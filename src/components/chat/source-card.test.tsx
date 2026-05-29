/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import type { CitationSource, DocumentCitationSource } from '@/types/citation'
import { ExternalLinkDialogProvider } from './markdown-utils'
import { SourceCard } from './source-card'
import { type ReactElement, type ReactNode } from 'react'

const renderWithProvider = (ui: ReactElement) =>
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ContentViewProvider>
        <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
      </ContentViewProvider>
    ),
  })

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

      const card = screen.getByRole('listitem')
      const img = card.querySelector('img')
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
      const img = container.querySelector('img')
      expect(img).toBeInTheDocument()
      expect(img).toHaveAttribute('src', 'https://example.com/favicon.ico')
    })

    it('should show initial badge when favicon fails to load', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const container = screen.getByRole('listitem')
      const img = container.querySelector('img')
      expect(img).toBeInTheDocument()

      fireEvent.error(img!)

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
    it('renders as a button (not an anchor)', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const card = screen.getByRole('listitem')
      expect(card.tagName).toBe('BUTTON')
    })

    it('should show external link dialog when clicked', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const card = screen.getByRole('listitem')
      fireEvent.click(card)

      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
      expect(screen.getByText('Open External Link')).toBeInTheDocument()
      expect(screen.getByText('https://example.com/article')).toBeInTheDocument()
    })

    it('should open URL in new window when dialog is confirmed', () => {
      const originalOpen = window.open
      const mockWindowOpen = mock(() => ({}) as Window)
      window.open = mockWindowOpen as typeof window.open

      renderWithProvider(<SourceCard source={mockSource} />)

      const card = screen.getByRole('listitem')
      fireEvent.click(card)

      const openButton = screen.getByRole('button', { name: 'Open Link' })
      fireEvent.click(openButton)

      expect(mockWindowOpen).toHaveBeenCalledWith('https://example.com/article', '_blank', 'noopener,noreferrer')

      window.open = originalOpen
    })

    it('invokes onSelect callback when clicked', () => {
      const onSelect = mock(() => {})
      renderWithProvider(<SourceCard source={mockSource} onSelect={onSelect} />)

      fireEvent.click(screen.getByRole('listitem'))

      expect(onSelect).toHaveBeenCalledTimes(1)
    })
  })

  describe('document citation behavior', () => {
    const docSource: DocumentCitationSource = {
      id: 'file-123:report.pdf',
      title: 'Quarterly Report',
      url: '',
      siteName: 'PDF',
      isPrimary: true,
      documentMeta: {
        fileId: 'file-123',
        fileName: 'report.pdf',
        pageNumber: 4,
      },
    }

    it('opens the document sideview when clicked', () => {
      const captured: { sideview: { sideviewType: string | null; sideviewId: string | null } | null } = {
        sideview: null,
      }
      const Capture = () => {
        const { state } = useContentView()
        captured.sideview =
          state.type === 'sideview'
            ? { sideviewType: state.data.sideviewType, sideviewId: state.data.sideviewId }
            : null
        return null
      }

      render(
        <ContentViewProvider>
          <ExternalLinkDialogProvider>
            <SourceCard source={docSource} />
            <Capture />
          </ExternalLinkDialogProvider>
        </ContentViewProvider>,
      )

      fireEvent.click(screen.getByRole('listitem'))

      expect(captured.sideview).toEqual({
        sideviewType: 'document',
        sideviewId: 'file-123:report.pdf:4',
      })
    })

    it('does not show external link dialog for documents', () => {
      renderWithProvider(<SourceCard source={docSource} />)

      fireEvent.click(screen.getByRole('listitem'))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })

    it('renders no favicon for document citations', () => {
      renderWithProvider(<SourceCard source={docSource} />)

      const card = screen.getByRole('listitem')
      expect(card.querySelector('img')).toBeNull()
      // Initial badge instead
      const badge = card.querySelector('[aria-hidden="true"]')
      expect(badge).toBeInTheDocument()
      expect(badge).toHaveTextContent('P')
    })
  })

  describe('accessibility', () => {
    it('should have listitem role for screen readers', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      expect(screen.getByRole('listitem')).toBeInTheDocument()
    })

    it('should have empty alt text on favicon', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const link = screen.getByRole('listitem')
      const img = link.querySelector('img')
      expect(img).toHaveAttribute('alt', '')
    })
  })

  describe('styling', () => {
    it('should apply custom className', () => {
      renderWithProvider(<SourceCard source={mockSource} className="custom-class" />)

      expect(screen.getByRole('listitem')).toHaveClass('custom-class')
    })

    it('should have proper card styling', () => {
      renderWithProvider(<SourceCard source={mockSource} />)

      const card = screen.getByRole('listitem')
      expect(card).toHaveClass('flex')
      expect(card).toHaveClass('flex-col')
      expect(card).toHaveClass('cursor-pointer')
    })

    it('should display colored badge when derived favicon fails to load', () => {
      const sourceWithoutFavicon = { ...mockSource, favicon: undefined, siteName: 'Apple' }
      const { container } = renderWithProvider(<SourceCard source={sourceWithoutFavicon} />)

      const img = container.querySelector('img')
      fireEvent.error(img!)

      const badge = container.querySelector('[aria-hidden="true"]')
      expect(badge).toBeTruthy()
      expect(badge?.classList.toString()).toContain('bg-')
    })
  })
})
