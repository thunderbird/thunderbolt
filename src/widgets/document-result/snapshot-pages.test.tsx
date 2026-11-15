/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
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
      render(<SnapshotPages title="report.docx" snapshot={{ kind: 'pages', html, width: 600 }} />)

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

  it('fills the panel when the pages fit in it', () => {
    const restore = mockVirtuaMeasurement({ viewportHeight: 800 })
    try {
      render(<SnapshotPages title="report.docx" snapshot={{ kind: 'pages', html, width: 280 }} />)

      const frame = screen.getByTitle('report.docx')
      expect(frame.style.width).toBe('100%')
      expect(frame.style.height).toBe('100%')
      expect(frame.style.transform).toBe('')
    } finally {
      restore()
    }
  })
})
