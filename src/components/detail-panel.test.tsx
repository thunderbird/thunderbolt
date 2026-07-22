/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { DetailPanel, DetailPanelSurface } from './detail-panel'

describe('DetailPanelSurface', () => {
  afterEach(() => {
    cleanup()
  })

  it('uses the shared responsive modal on mobile', () => {
    const onClose = mock()

    render(
      <DetailPanelSurface open isMobile onClose={onClose}>
        <p>Detail body</p>
      </DetailPanelSurface>,
    )

    expect(document.querySelector('[data-slot="responsive-modal-content"]')).toBeInTheDocument()
    expect(screen.getByText('Detail body')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the desktop detail header outside the modal shell', () => {
    const onClose = mock()

    render(
      <DetailPanelSurface open isMobile={false} onClose={onClose}>
        <DetailPanel title="Agent Name" subtitle="Your agent" onClose={onClose}>
          <p>Detail body</p>
        </DetailPanel>
      </DetailPanelSurface>,
    )

    expect(document.querySelector('[data-slot="responsive-modal-content"]')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close details' })).toBeInTheDocument()
  })
})
