/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { getFileType } from './file-type'

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

  test('takes .xlsx and .xlsm for workbooks, in any case, but not a bare name or an old .xls', () => {
    expect(getFileType('budget.xlsx')).toBe('xlsx')
    expect(getFileType('Macros.XLSM')).toBe('xlsx')
    expect(getFileType('xlsx')).toBe('unsupported')
    expect(getFileType('xlsm')).toBe('unsupported')
    expect(getFileType('legacy.xls')).toBe('unsupported')
  })
})
