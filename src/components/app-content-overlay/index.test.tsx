/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'

import { DetailPanelSurface } from '@/components/detail-panel'
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { AppContentOverlayHost, AppContentOverlayProvider } from '.'

afterEach(cleanup)

const Boundary = ({ children, browserOpen = true }: { children: ReactNode; browserOpen?: boolean }) => (
  <AppContentOverlayProvider>
    <div data-testid="main-content" className="relative">
      <p>Chat content</p>
      {browserOpen && <AppContentOverlayHost />}
    </div>
    <div data-testid="browser">Browser content</div>
    <div data-testid="sidebar-trigger">{children}</div>
  </AppContentOverlayProvider>
)

describe('AppContentOverlayHost', () => {
  it('bounds a sidebar-triggered dialog and its backdrop to the main content pane', () => {
    render(
      <Boundary>
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Create project</DialogTitle>
          </DialogContent>
        </Dialog>
      </Boundary>,
    )

    const host = document.querySelector<HTMLElement>('[data-slot="app-content-overlay-host"]')
    expect(host).toContainElement(screen.getByRole('dialog'))
    expect(host).toContainElement(document.querySelector('[data-slot="dialog-overlay"]'))
    expect(host).toHaveClass('[contain:layout]', 'absolute', 'inset-0')
    expect(screen.getByTestId('main-content')).toContainElement(host)
    expect(screen.getByTestId('browser')).not.toContainElement(host)
  })

  it('bounds alerts and sheets through their shared portal primitives', () => {
    const { rerender } = render(
      <Boundary>
        <AlertDialog open>
          <AlertDialogContent aria-describedby={undefined}>
            <AlertDialogTitle>Confirm change</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      </Boundary>,
    )
    expect(document.querySelector('[data-slot="app-content-overlay-host"]')).toContainElement(
      screen.getByRole('alertdialog'),
    )

    rerender(
      <Boundary>
        <Sheet open>
          <SheetContent aria-describedby={undefined}>
            <SheetTitle>Details</SheetTitle>
          </SheetContent>
        </Sheet>
      </Boundary>,
    )
    expect(document.querySelector('[data-slot="app-content-overlay-host"]')).toContainElement(
      screen.getByRole('dialog'),
    )
  })

  it('overlays a create aside inside the main pane instead of pushing the browser', () => {
    render(
      <Boundary>
        <DetailPanelSurface open onClose={() => undefined} topInset>
          <p>Create model form</p>
        </DetailPanelSurface>
      </Boundary>,
    )

    const aside = document.querySelector<HTMLElement>('[data-slot="slide-in-panel"]')
    expect(aside).toHaveClass('absolute', 'right-0', 'inset-y-0')
    expect(document.querySelector('[data-slot="app-content-overlay-host"]')).toContainElement(aside)
    expect(screen.getByTestId('sidebar-trigger')).not.toContainElement(aside)
    expect(aside).toHaveStyle({ width: 'min(100cqw, clamp(var(--create-panel-min-width), calc(50vw - 128px), 540px))' })
  })

  it('returns dialogs to the document portal after the browser boundary closes', () => {
    const dialog = (
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Project details</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    const { rerender } = render(<Boundary>{dialog}</Boundary>)
    rerender(<Boundary browserOpen={false}>{dialog}</Boundary>)

    expect(document.querySelector('[data-slot="app-content-overlay-host"]')).not.toBeInTheDocument()
    expect(document.body).toContainElement(screen.getByRole('dialog'))
    expect(screen.getByTestId('main-content')).not.toContainElement(screen.getByRole('dialog'))
  })
})
