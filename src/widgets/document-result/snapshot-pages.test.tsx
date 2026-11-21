/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { fitStyle } from './snapshot'
import { SnapshotPages } from './snapshot-pages'

const html = '<!DOCTYPE html><p>Page</p>'
const reflowStyle = '<style>p { width: auto; }</style>'

/**
 * The panel measures 300 by 800. The browser either draws the zoom probe's 400px block at its 100px container's width
 * with its 20px text 5px tall, or ignores the zoom.
 */
const renderInPanel = (zoomFits: boolean, ...snapshots: { title: string; width: number; reflowStyle?: string }[]) => {
  const restore = mockVirtuaMeasurement({ viewportHeight: 800 })
  spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    zoomFits ? new DOMRect(0, 0, 100, 5) : new DOMRect(0, 0, 400, 20),
  )
  for (const { title, ...snapshot } of snapshots) {
    render(<SnapshotPages title={title} snapshot={{ kind: 'pages', html, ...snapshot }} />)
  }
  restore()
}

describe('SnapshotPages', () => {
  afterEach(() => {
    cleanup()
    restoreViewport()
    mock.restore()
  })

  it('fills the panel with the pages in a sandboxed frame, and adds the style that zooms them to its width', () => {
    renderInPanel(true, { title: 'report.docx', width: 600, reflowStyle })

    const frame = screen.getByTitle('report.docx')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toBe(html + fitStyle(600))
    expect(frame.style.width).toBe('100%')
    expect(frame.style.height).toBe('100%')
    expect(frame.style.transform).toBe('')
  })

  it('adds the reflow style instead on a phone, and the fit style to slides, which have none', () => {
    forceMobileViewport()
    renderInPanel(true, { title: 'report.docx', width: 600, reflowStyle }, { title: 'deck.pptx', width: 600 })

    expect(screen.getByTitle('report.docx').getAttribute('srcdoc')).toBe(html + reflowStyle)
    expect(screen.getByTitle('deck.pptx').getAttribute('srcdoc')).toBe(html + fitStyle(600))
  })

  it('scales down a frame as wide as the pages, without the fit style, when the browser cannot zoom them as they are', () => {
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
    expect(screen.getByTitle('deck.pptx').getAttribute('srcdoc')).toBe(html)
    expect(screen.getByTitle('deck.pptx').style.transform).toBe('scale(0.5)')
  })
})
