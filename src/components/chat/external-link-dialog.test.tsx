import '@/testing-library'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { ExternalLinkDialog } from './external-link-dialog'

describe('ExternalLinkDialog', () => {
  const mockOnOpenChange = mock()
  const mockOnConfirm = mock()

  const defaultProps = {
    open: true,
    onOpenChange: mockOnOpenChange,
    url: 'https://example.com',
    onConfirm: mockOnConfirm,
  }

  describe('rendering', () => {
    it('should display dialog when open is true', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
      expect(screen.getByText('Open external link')).toBeInTheDocument()
      expect(screen.getByText("You're leaving Thunderbolt to visit an external link:")).toBeInTheDocument()
    })

    it('should not display dialog when open is false', () => {
      render(<ExternalLinkDialog {...defaultProps} open={false} />)

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })

    it('should display the URL', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      expect(screen.getByText('https://example.com')).toBeInTheDocument()
    })

    it('should display Cancel and Open link buttons', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open link' })).toBeInTheDocument()
    })

    it('should display openError when provided', () => {
      render(<ExternalLinkDialog {...defaultProps} openError="Could not open link." />)

      expect(screen.getByText('Could not open link.')).toBeInTheDocument()
    })

    it('should show Opening… and disable Open button when isOpening', () => {
      render(<ExternalLinkDialog {...defaultProps} isOpening />)

      const openButton = screen.getByRole('button', { name: 'Opening…' })
      expect(openButton).toBeDisabled()
    })

    it('should render "Open in Thunderbolt" button when onOpenInApp is provided', () => {
      const mockOpenInApp = mock()
      render(<ExternalLinkDialog {...defaultProps} onOpenInApp={mockOpenInApp} />)

      expect(screen.getByRole('button', { name: 'Open in Thunderbolt' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open in Browser' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Open link' })).not.toBeInTheDocument()
    })

    it('should not render "Open in Thunderbolt" button when onOpenInApp is not provided', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      expect(screen.queryByRole('button', { name: 'Open in Thunderbolt' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open link' })).toBeInTheDocument()
    })
  })

  describe('URL display', () => {
    it('should handle very long URLs', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(500)
      render(<ExternalLinkDialog {...defaultProps} url={longUrl} />)

      expect(screen.getByText(longUrl)).toBeInTheDocument()
    })

    it('should handle URLs with special characters', () => {
      const specialUrl = 'https://example.com/path?foo=bar&baz=qux#fragment'
      render(<ExternalLinkDialog {...defaultProps} url={specialUrl} />)

      expect(screen.getByText(specialUrl)).toBeInTheDocument()
    })
  })

  describe('interaction', () => {
    it('should call onConfirm when Open link button is clicked', () => {
      const mockConfirm = mock()
      render(<ExternalLinkDialog {...defaultProps} onConfirm={mockConfirm} />)

      const openButton = screen.getByRole('button', { name: 'Open link' })
      fireEvent.click(openButton)

      expect(mockConfirm).toHaveBeenCalledTimes(1)
    })

    it('should call onOpenInApp when "Open in Thunderbolt" button is clicked', () => {
      const mockOpenInApp = mock()
      render(<ExternalLinkDialog {...defaultProps} onOpenInApp={mockOpenInApp} />)

      fireEvent.click(screen.getByRole('button', { name: 'Open in Thunderbolt' }))

      expect(mockOpenInApp).toHaveBeenCalledTimes(1)
    })

    it('should call onOpenChange when Cancel button is clicked', () => {
      const mockChange = mock()
      render(<ExternalLinkDialog {...defaultProps} onOpenChange={mockChange} />)

      const cancelButton = screen.getByRole('button', { name: 'Cancel' })
      fireEvent.click(cancelButton)

      expect(mockChange).toHaveBeenCalledWith(false)
    })

    it('should call onOpenError when onConfirm promise rejects', async () => {
      const rejectError = new Error('open failed')
      let resolveReport: (err: unknown) => void
      const reported = new Promise<unknown>((resolve) => {
        resolveReport = resolve
      })
      const mockConfirm = () => Promise.reject(rejectError)
      const onOpenError = (err: unknown) => resolveReport!(err)
      render(<ExternalLinkDialog {...defaultProps} onConfirm={mockConfirm} onOpenError={onOpenError} />)

      fireEvent.click(screen.getByRole('button', { name: 'Open link' }))

      const reportedError = await reported
      expect(reportedError).toBe(rejectError)
    })
  })

  describe('accessibility', () => {
    it('should have alertdialog role', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      const dialog = screen.getByRole('alertdialog')
      expect(dialog).toBeInTheDocument()
    })

    it('should have proper title and description', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      // Title should be associated with the dialog
      expect(screen.getByText('Open external link')).toBeInTheDocument()

      // Description should be present
      expect(screen.getByText("You're leaving Thunderbolt to visit an external link:")).toBeInTheDocument()
    })
  })
})
