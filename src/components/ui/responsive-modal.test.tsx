/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { FormFooter } from '@/components/ui/form-footer'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import {
  getResponsiveModalSurfaceClass,
  getResponsiveModalSurfaceStyle,
  ResponsiveModal,
  ResponsiveModalCancel,
  ResponsiveModalContent,
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
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

  afterEach(() => {
    restoreViewport()
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
        <FormFooter>
          <button type="button">Action</button>
        </FormFooter>
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

  describe('shared mobile surface', () => {
    it('uses the full-screen shell and touch-sized close control', () => {
      forceMobileViewport()
      renderModal()

      const close = screen.getByRole('button', { name: 'Close' })
      const surface = document.querySelector('[data-slot="responsive-modal-content"]')
      const mobileSurfaceClass = getResponsiveModalSurfaceClass(true, 'structured')

      expect(mobileSurfaceClass).toContain('h-dvh')
      expect(mobileSurfaceClass).toContain('p-4')
      expect(surface).toHaveClass('[&_[data-slot=input]]:!bg-card')
      expect(surface).toHaveClass('[&_[data-slot=combobox-trigger]]:!bg-card')
      expect(close).toHaveClass('left-2')
      expect(close.className).toContain('size-[var(--touch-height-lg)]')
      expect(close.className).toContain('md:size-[var(--touch-height-sm)]')
    })

    it('reserves the keyboard inset so a covered form can still be scrolled', () => {
      // h-dvh does not shrink for the keyboard, so without this the surface
      // still "fits" the viewport and the scroller has nothing to hand over.
      expect(getResponsiveModalSurfaceClass(true, 'structured')).toContain('overflow-auto')
      expect(getResponsiveModalSurfaceStyle(true)?.paddingBottom).toBe('var(--modal-bottom-inset)')
    })

    it('leaves the desktop surface unpadded by mobile safe areas', () => {
      expect(getResponsiveModalSurfaceStyle(false)).toBeUndefined()
    })

    it('clears the pinned controls and the bottom inset by default', () => {
      expect(getResponsiveModalSurfaceStyle(true)?.paddingTop).toBe('var(--modal-top-inset)')
    })

    it('runs flush content corner to corner behind a masked scrim', () => {
      expect(getResponsiveModalSurfaceStyle(true, true)).toEqual({ paddingBottom: 0, paddingTop: 0 })
      forceMobileViewport()

      render(
        <Dialog open>
          <ResponsiveModalContentComposable flush>
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Flush Title</ResponsiveModalTitle>
            </ResponsiveModalHeader>
          </ResponsiveModalContentComposable>
        </Dialog>,
        { wrapper: createTestProvider() },
      )

      const scrim = document.querySelector<HTMLElement>('[data-slot="responsive-modal-top-scrim"]')
      expect(scrim).toBeInTheDocument()
      // Masked, so the blur fades out instead of drawing an edge across content.
      expect(scrim?.className).toContain('backdrop-blur-[4px]')
      expect(scrim?.style.maskImage).toContain('linear-gradient(to bottom')
    })

    it('omits the scrim when content starts below the controls', () => {
      forceMobileViewport()

      render(
        <Dialog open>
          <ResponsiveModalContentComposable>
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Inset Title</ResponsiveModalTitle>
            </ResponsiveModalHeader>
          </ResponsiveModalContentComposable>
        </Dialog>,
        { wrapper: createTestProvider() },
      )

      expect(document.querySelector('[data-slot="responsive-modal-top-scrim"]')).not.toBeInTheDocument()
    })

    it('uses the same shell for the composable API', () => {
      render(
        <Dialog open>
          <ResponsiveModalContentComposable>
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Composable Title</ResponsiveModalTitle>
            </ResponsiveModalHeader>
          </ResponsiveModalContentComposable>
        </Dialog>,
        { wrapper: createTestProvider() },
      )

      expect(getResponsiveModalSurfaceClass(true, 'composable')).toContain('h-dvh')
      expect(document.querySelector('[data-slot="responsive-modal-content"]')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('uses the same field surfaces in plain dialogs', () => {
      render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Plain Dialog</DialogTitle>
            <input data-slot="input" />
          </DialogContent>
        </Dialog>,
      )

      const surface = document.querySelector('[data-slot="dialog-content"]')
      expect(surface).toHaveClass('[&_[data-slot=input]]:!bg-card')
      expect(surface).toHaveClass('dark:[&_[data-slot=input]]:!bg-input')
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

  it('gives the mobile cancel action a frosted fill', () => {
    render(<ResponsiveModalCancel className="custom-class" />, { wrapper: createTestProvider() })

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toHaveClass('max-md:bg-background/80')
    expect(cancel).toHaveClass('max-md:backdrop-blur-md')
    expect(cancel).toHaveClass('custom-class')
  })

  it('anchors modal actions at the bottom of the surface', () => {
    renderModal()

    expect(screen.getByRole('button', { name: 'Action' }).closest('[data-slot="form-footer"]')?.className).toContain(
      'mt-auto',
    )
  })
})
