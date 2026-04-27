/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from './responsive-modal'

describe('ResponsiveModal', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  const renderModal = (
    props: Partial<{ open: boolean; onOpenChange: (open: boolean) => void; showCloseButton: boolean }> = {},
  ) => {
    const onOpenChange = props.onOpenChange ?? mock()
    return render(
      <ResponsiveModal open={props.open ?? true} onOpenChange={onOpenChange} showCloseButton={props.showCloseButton}>
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Test Title</ResponsiveModalTitle>
          <ResponsiveModalDescription>Test description text</ResponsiveModalDescription>
        </ResponsiveModalHeader>
        <ResponsiveModalContent>
          <p>Modal content</p>
        </ResponsiveModalContent>
        <ResponsiveModalFooter>
          <button type="button">Action</button>
        </ResponsiveModalFooter>
      </ResponsiveModal>,
      { wrapper: createTestProvider() },
    )
  }

  describe('rendering', () => {
    it('renders when open', () => {
      renderModal({ open: true })
      expect(screen.getByRole('heading', { name: 'Test Title' })).toBeInTheDocument()
      expect(screen.getByText('Test description text')).toBeInTheDocument()
      expect(screen.getByText('Modal content')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Action' })).toBeInTheDocument()
    })

    it('does not render content when closed', () => {
      renderModal({ open: false })
      expect(screen.queryByRole('heading', { name: 'Test Title' })).not.toBeInTheDocument()
      expect(screen.queryByText('Modal content')).not.toBeInTheDocument()
    })

    it('shows close button by default', () => {
      renderModal()
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('hides close button when showCloseButton is false', () => {
      renderModal({ showCloseButton: false })
      expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    })
  })

  describe('close behavior', () => {
    it('calls onOpenChange(false) when close button is clicked', () => {
      const onOpenChange = mock()
      renderModal({ onOpenChange })
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  describe('ResponsiveModalContent', () => {
    it('applies centered class when centered prop is true', () => {
      render(
        <ResponsiveModal open={true} onOpenChange={() => {}}>
          <ResponsiveModalContent centered data-testid="content">
            <p>Centered content</p>
          </ResponsiveModalContent>
        </ResponsiveModal>,
        { wrapper: createTestProvider() },
      )
      const content = screen.getByTestId('content')
      expect(content.className).toContain('justify-center')
    })

    it('does not apply centered class when centered is false', () => {
      render(
        <ResponsiveModal open={true} onOpenChange={() => {}}>
          <ResponsiveModalContent data-testid="content">
            <p>Content</p>
          </ResponsiveModalContent>
        </ResponsiveModal>,
        { wrapper: createTestProvider() },
      )
      const content = screen.getByTestId('content')
      expect(content.className).not.toContain('justify-center')
    })
  })
})
