/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
      expect(screen.getByText('Open External Link')).toBeInTheDocument()
    })

    it('should not display dialog when open is false', () => {
      render(<ExternalLinkDialog {...defaultProps} open={false} />)

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })

    it('should display the URL', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      expect(screen.getByText('https://example.com')).toBeInTheDocument()
    })

    it('should display close button and Open link button', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open Link' })).toBeInTheDocument()
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

    it('should keep close button enabled when isOpening', () => {
      render(<ExternalLinkDialog {...defaultProps} isOpening />)

      expect(screen.getByRole('button', { name: 'Close' })).not.toBeDisabled()
    })

    it('should render "Open in Sidebar" button when onOpenInApp is provided', () => {
      const mockOpenInApp = mock()
      render(<ExternalLinkDialog {...defaultProps} onOpenInApp={mockOpenInApp} />)

      expect(screen.getByRole('button', { name: 'Open in Sidebar' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open in Browser' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Open Link' })).not.toBeInTheDocument()
    })

    it('should not render "Open in Sidebar" button when onOpenInApp is not provided', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      expect(screen.queryByRole('button', { name: 'Open in Sidebar' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open Link' })).toBeInTheDocument()
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

      const openButton = screen.getByRole('button', { name: 'Open Link' })
      fireEvent.click(openButton)

      expect(mockConfirm).toHaveBeenCalledTimes(1)
    })

    it('should call onOpenInApp when "Open in Sidebar" button is clicked', () => {
      const mockOpenInApp = mock()
      render(<ExternalLinkDialog {...defaultProps} onOpenInApp={mockOpenInApp} />)

      fireEvent.click(screen.getByRole('button', { name: 'Open in Sidebar' }))

      expect(mockOpenInApp).toHaveBeenCalledTimes(1)
    })

    it('should call onOpenChange when close button is clicked', () => {
      const mockChange = mock()
      render(<ExternalLinkDialog {...defaultProps} onOpenChange={mockChange} />)

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      expect(mockChange).toHaveBeenCalledWith(false)
    })

    it('should allow closing via X button even while isOpening', () => {
      const mockChange = mock()
      render(<ExternalLinkDialog {...defaultProps} onOpenChange={mockChange} isOpening />)

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      expect(mockChange).toHaveBeenCalledWith(false)
    })

    it('should allow closing via Escape even while isOpening', () => {
      const mockChange = mock()
      render(<ExternalLinkDialog {...defaultProps} onOpenChange={mockChange} isOpening />)

      const dialog = screen.getByRole('alertdialog')
      fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })

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

      fireEvent.click(screen.getByRole('button', { name: 'Open Link' }))

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

    it('should have proper title', () => {
      render(<ExternalLinkDialog {...defaultProps} />)

      expect(screen.getByText('Open External Link')).toBeInTheDocument()
    })
  })
})
