/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { Dialog } from '@/components/ui/dialog'
import { ResponsiveModalContentComposable } from '@/components/ui/responsive-modal'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { ContentViewHeader } from './header'

describe('ContentViewHeader', () => {
  afterEach(() => {
    cleanup()
    restoreViewport()
  })

  it('uses the standard modal controls on mobile', () => {
    forceMobileViewport()
    const onClose = mock()

    render(
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <ResponsiveModalContentComposable flush>
          <ContentViewHeader title="Reasoning" onClose={onClose} actions={<button type="button">Copy</button>} />
        </ResponsiveModalContentComposable>
      </Dialog>,
    )

    const closeButton = screen.getByRole('button', { name: 'Close' })
    expect(closeButton).toHaveClass('left-4')
    expect(screen.getByRole('button', { name: 'Copy' }).parentElement).toHaveClass('fixed', 'right-4')
    expect(screen.getByRole('heading', { name: 'Reasoning' }).parentElement).toHaveClass(
      'pt-[calc(var(--modal-top-inset)+1rem)]',
    )

    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
