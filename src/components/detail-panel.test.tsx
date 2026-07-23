/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { ResponsiveModalFooter } from './ui/responsive-modal'
import { DetailPanel, DetailPanelSurface } from './detail-panel'

describe('DetailPanelSurface', () => {
  afterEach(() => {
    cleanup()
  })

  it('uses the shared responsive modal on mobile', () => {
    const onClose = mock()

    render(
      <DetailPanelSurface open isMobile onClose={onClose}>
        <DetailPanel title="Detail title" onClose={onClose}>
          <p>Detail body</p>
          <ResponsiveModalFooter>
            <button type="button">Save</button>
          </ResponsiveModalFooter>
        </DetailPanel>
      </DetailPanelSurface>,
    )

    expect(document.querySelector('[data-slot="responsive-modal-content"]')).toBeInTheDocument()
    expect(screen.getByText('Detail body')).toBeInTheDocument()
    const scrollArea = screen.getByText('Detail body').parentElement
    expect(scrollArea).toHaveClass('pt-6', 'md:pt-4', '[&_[data-slot=dialog-footer]]:sticky')

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('adds more mobile spacing below a subtitle', () => {
    render(
      <DetailPanelSurface open isMobile onClose={() => {}}>
        <DetailPanel title="MCP server" subtitle="https://example.com/mcp" onClose={() => {}}>
          <p>Server status</p>
        </DetailPanel>
      </DetailPanelSurface>,
    )

    expect(screen.getByText('Server status').parentElement).toHaveClass('pt-8', 'md:pt-4')
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
    const surface = screen.getByText('Detail body').closest('.bg-sidebar')
    expect(surface?.closest('aside')).toHaveClass('[filter:drop-shadow(var(--shadow-glow-strong))]')
    expect(surface?.parentElement).toHaveClass('pb-12')
    expect(surface?.parentElement).not.toHaveClass('pt-3')
    expect(surface?.parentElement).not.toHaveClass('pl-4')
  })
})
