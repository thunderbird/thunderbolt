/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { floatingFormFooterClass, FormFooter } from './ui/form-footer'
import { DetailPanel, DetailPanelSurface } from './detail-panel'

describe('DetailPanelSurface', () => {
  afterEach(() => {
    cleanup()
    restoreViewport()
  })

  it('uses the shared responsive modal on mobile', () => {
    forceMobileViewport()
    const onClose = mock()

    render(
      <DetailPanelSurface open onClose={onClose}>
        <DetailPanel title="Detail title" onClose={onClose}>
          <p>Detail body</p>
          <FormFooter>
            <button type="button">Save</button>
          </FormFooter>
        </DetailPanel>
      </DetailPanelSurface>,
    )

    expect(document.querySelector('[data-slot="responsive-modal-content"]')).toBeInTheDocument()
    expect(screen.getByText('Detail body')).toBeInTheDocument()
    const scrollArea = screen.getByText('Detail body').parentElement
    expect(scrollArea).toHaveClass('md:pt-4', 'max-md:[&_[data-slot=form-footer]]:absolute')

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('scrolls the mobile title block with the body, leaving only the corner controls pinned', () => {
    forceMobileViewport()

    render(
      <DetailPanelSurface open onClose={() => {}}>
        <DetailPanel title="MCP server" subtitle="https://example.com/mcp" onClose={() => {}}>
          <p>Server status</p>
        </DetailPanel>
      </DetailPanelSurface>,
    )

    const scrollArea = screen.getByText('Server status').parentElement
    expect(scrollArea).toHaveClass('overflow-y-auto')
    // Title and subtitle live inside the scroller, not pinned above it.
    expect(scrollArea).toContainElement(screen.getByRole('heading', { name: 'MCP server' }))
    expect(scrollArea).toContainElement(screen.getByText('https://example.com/mcp'))
  })

  it('keeps the desktop title block pinned above the scroller', () => {
    render(
      <DetailPanelSurface open onClose={() => {}}>
        <DetailPanel title="MCP server" subtitle="https://example.com/mcp" onClose={() => {}}>
          <p>Server status</p>
        </DetailPanel>
      </DetailPanelSurface>,
    )

    const scrollArea = screen.getByText('Server status').parentElement
    expect(scrollArea).not.toContainElement(screen.getByText('MCP server'))
  })

  it('floats the mobile footer over the body behind a gradually faded blur', () => {
    forceMobileViewport()
    render(
      <DetailPanelSurface open onClose={() => {}}>
        <DetailPanel title="Detail title" onClose={() => {}}>
          <p>Detail body</p>
          <FormFooter>
            <button type="button">Save</button>
          </FormFooter>
        </DetailPanel>
      </DetailPanelSurface>,
    )

    const scrollArea = screen.getByText('Detail body').parentElement
    expect(scrollArea?.className).toContain(floatingFormFooterClass)
    expect(floatingFormFooterClass).toContain('before:backdrop-blur-[4px]')
    // Masked, so the blur has no hard top edge...
    expect(floatingFormFooterClass).toContain('mask-image:linear-gradient(to_top')
    // ...and on a pseudo-element, so the mask can't fade the buttons themselves.
    expect(floatingFormFooterClass).not.toMatch(/form-footer\]\]:(backdrop-blur|bg-gradient)/)
  })

  it('anchors the mobile footer to the panel edge and scrims through it', () => {
    expect(floatingFormFooterClass).toContain('[bottom:var(--modal-footer-inset)]')
    expect(floatingFormFooterClass).toContain('inset-x-4')
    expect(floatingFormFooterClass).not.toContain('margin-bottom')
    expect(floatingFormFooterClass).toContain('before:[bottom:calc(-1*var(--modal-footer-inset)-1rem)]')
  })

  it('shrinks the mobile panel above the keyboard and keeps the footer clear', () => {
    forceMobileViewport()

    render(
      <DetailPanelSurface open onClose={() => {}}>
        <DetailPanel title="Detail title" onClose={() => {}}>
          <p>Detail body</p>
        </DetailPanel>
      </DetailPanelSurface>,
    )

    const scrollArea = screen.getByText('Detail body').parentElement
    expect(scrollArea).toHaveClass('max-md:pb-[calc(var(--touch-height-default)+var(--modal-footer-inset))]')
    expect(scrollArea).toHaveClass('max-md:after:h-[var(--kb,0px)]', 'max-md:after:shrink-0')

    const panel = screen.getByText('Detail body').closest('section')
    expect(panel?.style.maxHeight).toBe('calc(100% - var(--kb, 0px))')
    expect(panel).toHaveClass('md:pb-5')
    expect(panel?.className).not.toMatch(/(^|\s)pb-5(\s|$)/)
  })

  it('keeps the desktop detail header outside the modal shell', () => {
    const onClose = mock()

    render(
      <DetailPanelSurface open onClose={onClose}>
        <DetailPanel title="Agent Name" subtitle="Your agent" onClose={onClose}>
          <p>Detail body</p>
        </DetailPanel>
      </DetailPanelSurface>,
    )

    expect(document.querySelector('[data-slot="responsive-modal-content"]')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close details' })).toBeInTheDocument()
    const surface = screen.getByText('Detail body').closest('.bg-sidebar')
    expect(surface?.closest('[data-slot="slide-in-panel"]')).toHaveClass(
      '[filter:drop-shadow(var(--shadow-glow-strong))]',
    )
    expect(surface?.parentElement).toHaveClass('pb-12')
    expect(surface?.parentElement).not.toHaveClass('pt-3')
    expect(surface?.parentElement).not.toHaveClass('pl-4')
  })
})
