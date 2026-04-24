import { describe, expect, it } from 'bun:test'
import { buildDocumentSideviewId, parseDocumentSideviewId } from './citation'

describe('buildDocumentSideviewId', () => {
  it('builds ID without page number', () => {
    expect(buildDocumentSideviewId({ fileId: 'f1', fileName: 'doc.pdf' })).toBe('f1:doc.pdf')
  })

  it('builds ID with page number', () => {
    expect(buildDocumentSideviewId({ fileId: 'f1', fileName: 'doc.pdf', pageNumber: 5 })).toBe('f1:doc.pdf:5')
  })

  it('handles file names with colons', () => {
    expect(buildDocumentSideviewId({ fileId: 'f1', fileName: 'file:name.pdf' })).toBe('f1:file:name.pdf')
  })
})

describe('parseDocumentSideviewId', () => {
  it('parses ID without page number', () => {
    expect(parseDocumentSideviewId('f1:doc.pdf')).toEqual({
      fileId: 'f1',
      fileName: 'doc.pdf',
    })
  })

  it('parses ID with page number', () => {
    expect(parseDocumentSideviewId('f1:doc.pdf:5')).toEqual({
      fileId: 'f1',
      fileName: 'doc.pdf',
      pageNumber: 5,
    })
  })

  it('handles file names with colons', () => {
    expect(parseDocumentSideviewId('f1:file:name.pdf')).toEqual({
      fileId: 'f1',
      fileName: 'file:name.pdf',
    })
  })

  it('handles file names with colons AND page numbers', () => {
    expect(parseDocumentSideviewId('f1:file:name.pdf:3')).toEqual({
      fileId: 'f1',
      fileName: 'file:name.pdf',
      pageNumber: 3,
    })
  })

  it('does not treat non-numeric last segment as page number', () => {
    expect(parseDocumentSideviewId('f1:doc:txt')).toEqual({
      fileId: 'f1',
      fileName: 'doc:txt',
    })
  })
})
