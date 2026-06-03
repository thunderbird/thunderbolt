/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  buildDocumentSideviewId,
  isDocumentCitation,
  parseDocumentSideviewId,
  type CitationSource,
  type DocumentCitationSource,
} from './citation'

describe('buildDocumentSideviewId', () => {
  test('encodes fileId + fileName without pageNumber', () => {
    expect(buildDocumentSideviewId({ fileId: 'abc-1', fileName: 'report.pdf' })).toBe('abc-1:report.pdf')
  })

  test('appends pageNumber when present', () => {
    expect(buildDocumentSideviewId({ fileId: 'abc-1', fileName: 'report.pdf', pageNumber: 12 })).toBe(
      'abc-1:report.pdf:12',
    )
  })
})

describe('parseDocumentSideviewId', () => {
  test('roundtrips simple id', () => {
    const parsed = parseDocumentSideviewId('abc-1:report.pdf')
    expect(parsed).toEqual({ fileId: 'abc-1', fileName: 'report.pdf' })
  })

  test('roundtrips id with pageNumber', () => {
    const parsed = parseDocumentSideviewId('abc-1:report.pdf:7')
    expect(parsed).toEqual({ fileId: 'abc-1', fileName: 'report.pdf', pageNumber: 7 })
  })

  test('keeps colons in filename when no trailing number', () => {
    const parsed = parseDocumentSideviewId('id:weird:name.pdf')
    expect(parsed).toEqual({ fileId: 'id', fileName: 'weird:name.pdf' })
  })

  test('treats trailing integer as page number', () => {
    const parsed = parseDocumentSideviewId('uuid:my:file.pdf:3')
    expect(parsed).toEqual({ fileId: 'uuid', fileName: 'my:file.pdf', pageNumber: 3 })
  })

  test('does not parse non-numeric tail as page number', () => {
    const parsed = parseDocumentSideviewId('uuid:my.pdf:final')
    expect(parsed).toEqual({ fileId: 'uuid', fileName: 'my.pdf:final' })
  })
})

describe('isDocumentCitation', () => {
  test('returns true for sources with documentMeta', () => {
    const docSource: DocumentCitationSource = {
      id: 'a:b.pdf',
      title: 'b.pdf',
      url: '',
      documentMeta: { fileId: 'a', fileName: 'b.pdf' },
    }
    expect(isDocumentCitation(docSource)).toBe(true)
  })

  test('returns false for plain URL citations', () => {
    const source: CitationSource = { id: '1', title: 'Foo', url: 'https://example.com' }
    expect(isDocumentCitation(source)).toBe(false)
  })

  test('returns false when documentMeta is explicitly undefined-like', () => {
    const source = { id: '1', title: 'Foo', url: 'https://example.com', documentMeta: undefined } as CitationSource
    expect(isDocumentCitation(source)).toBe(false)
  })
})
