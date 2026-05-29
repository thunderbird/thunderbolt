/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { getFileType } from './pdf-sidebar-viewer'

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
