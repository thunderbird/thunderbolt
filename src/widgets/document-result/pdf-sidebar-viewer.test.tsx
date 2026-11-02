/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ContentViewProvider } from '@/content-view/context'
import { getFileType, LocalPdfSidebarViewer } from './pdf-sidebar-viewer'

describe('getFileType', () => {
  test('detects PDF', () => {
    expect(getFileType('report.pdf')).toBe('pdf')
  })

  test('detects DOCX', () => {
    expect(getFileType('notes.docx')).toBe('docx')
  })

  test('treats DOC as unsupported (only DOCX is preview-able)', () => {
    expect(getFileType('legacy.doc')).toBe('unsupported')
  })

  test('returns unsupported for unknown extension', () => {
    expect(getFileType('something.txt')).toBe('unsupported')
  })

  test('is case insensitive', () => {
    expect(getFileType('REPORT.PDF')).toBe('pdf')
    expect(getFileType('NOTES.DocX')).toBe('docx')
  })

  test('returns unsupported when there is no extension', () => {
    expect(getFileType('README')).toBe('unsupported')
  })
})

describe('LocalPdfSidebarViewer', () => {
  afterEach(cleanup)

  test('gives the header icon buttons accessible names', () => {
    render(
      <ContentViewProvider trackEvent={mock()}>
        <LocalPdfSidebarViewer localFileId="missing" fileName="sample.pdf" />
      </ContentViewProvider>,
    )

    expect(screen.getByRole('heading', { name: 'sample.pdf' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })
})
