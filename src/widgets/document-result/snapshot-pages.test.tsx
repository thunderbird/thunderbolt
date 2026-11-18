/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { SnapshotPages } from './snapshot-pages'

const html = '<!DOCTYPE html><p>Page</p>'
const reflowStyle = '<style>p { width: auto; }</style>'

/** The panel measures 300 by 800, and the browser either scales the pages inside the frame or cannot. */
const renderInPanel = (zoomFits: boolean, ...snapshots: { title: string; width: number; reflowStyle?: string }[]) => {
  const restore = mockVirtuaMeasurement({ viewportHeight: 800 })
  // The test DOM builds a new `CSS` on every read, so spy on the method they share.
  const supports = spyOn(Object.getPrototypeOf(CSS), 'supports').mockReturnValue(zoomFits)
  for (const { title, ...snapshot } of snapshots) {
    render(<SnapshotPages title={title} snapshot={{ kind: 'pages', html, ...snapshot }} />)
  }
  restore()
  return supports
}

describe('SnapshotPages', () => {
  afterEach(() => {
    cleanup()
    restoreViewport()
    mock.restore()
  })

  it('fills the panel with the pages in a sandboxed frame, which scales them down itself', () => {
    const supports = renderInPanel(true, { title: 'report.docx', width: 600, reflowStyle })

    const frame = screen.getByTitle('report.docx')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toBe(html)
    expect(frame.style.width).toBe('100%')
    expect(frame.style.height).toBe('100%')
    expect(frame.style.transform).toBe('')
    expect(supports).toHaveBeenCalledWith('zoom', expect.stringContaining('100cqw'))
  })

  it('adds the reflow style on a phone, and leaves slides, which have none, to scale there', () => {
    forceMobileViewport()
    renderInPanel(true, { title: 'report.docx', width: 600, reflowStyle }, { title: 'deck.pptx', width: 600 })

    expect(screen.getByTitle('report.docx').getAttribute('srcdoc')).toBe(html + reflowStyle)
    expect(screen.getByTitle('deck.pptx').getAttribute('srcdoc')).toBe(html)
  })

  it('scales down a frame as wide as the pages when the browser cannot scale them inside it', () => {
    renderInPanel(false, { title: 'report.docx', width: 600, reflowStyle }, { title: 'narrow.docx', width: 280 })

    const frame = screen.getByTitle('report.docx')
    expect(frame.getAttribute('srcdoc')).toBe(html)
    expect(frame.style.width).toBe('600px')
    expect(frame.style.height).toBe('1600px')
    expect(frame.style.transform).toBe('scale(0.5)')
    // Pages that fit fill the panel.
    expect(screen.getByTitle('narrow.docx').style.transform).toBe('')
    expect(screen.getByTitle('narrow.docx').style.width).toBe('100%')
  })

  it('still reflows pages on a phone in such a browser, and scales slides there', () => {
    forceMobileViewport()
    renderInPanel(false, { title: 'report.docx', width: 600, reflowStyle }, { title: 'deck.pptx', width: 600 })

    const page = screen.getByTitle('report.docx')
    expect(page.getAttribute('srcdoc')).toBe(html + reflowStyle)
    expect(page.style.width).toBe('100%')
    expect(page.style.transform).toBe('')
    expect(screen.getByTitle('deck.pptx').style.transform).toBe('scale(0.5)')
  })
})
