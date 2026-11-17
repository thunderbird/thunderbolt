/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { SnapshotPages } from './snapshot-pages'

const html = '<!DOCTYPE html><p>Page</p>'

describe('SnapshotPages', () => {
  afterEach(cleanup)

  it('scales pages wider than the panel down to its width, as on a phone', () => {
    // The panel measures 300 by 800.
    const restore = mockVirtuaMeasurement({ viewportHeight: 800 })
    try {
      render(<SnapshotPages title="report.docx" snapshot={{ kind: 'pages', html, width: 600, reflows: true }} />)

      const frame = screen.getByTitle('report.docx')
      expect(frame.getAttribute('sandbox')).toBe('')
      expect(frame.getAttribute('srcdoc')).toBe(html)
      expect(frame.style.width).toBe('600px')
      expect(frame.style.height).toBe('1600px')
      expect(frame.style.transform).toBe('scale(0.5)')
    } finally {
      restore()
    }
  })

  it('gives pages that reflow the panel width on a phone, and still scales slides there', () => {
    const restore = mockVirtuaMeasurement({ viewportHeight: 800 })
    forceMobileViewport()
    try {
      render(<SnapshotPages title="report.docx" snapshot={{ kind: 'pages', html, width: 600, reflows: true }} />)
      render(<SnapshotPages title="deck.pptx" snapshot={{ kind: 'pages', html, width: 600, reflows: false }} />)

      const page = screen.getByTitle('report.docx')
      expect(page.style.width).toBe('100%')
      expect(page.style.transform).toBe('')
      expect(screen.getByTitle('deck.pptx').style.transform).toBe('scale(0.5)')
    } finally {
      restoreViewport()
      restore()
    }
  })

  it('fills the panel when the pages fit in it', () => {
    const restore = mockVirtuaMeasurement({ viewportHeight: 800 })
    try {
      render(<SnapshotPages title="report.docx" snapshot={{ kind: 'pages', html, width: 280, reflows: true }} />)

      const frame = screen.getByTitle('report.docx')
      expect(frame.style.width).toBe('100%')
      expect(frame.style.height).toBe('100%')
      expect(frame.style.transform).toBe('')
    } finally {
      restore()
    }
  })
})
