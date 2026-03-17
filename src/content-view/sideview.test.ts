import { describe, expect, test } from 'bun:test'
import { parseDocumentSideviewId } from './sideview'

describe('parseDocumentSideviewId', () => {
  test('parses "fileId:fileName" → { fileId, fileName, pageNumber: undefined }', () => {
    const result = parseDocumentSideviewId('abc123:report.pdf')
    expect(result).toEqual({ fileId: 'abc123', fileName: 'report.pdf', pageNumber: undefined })
  })

  test('parses "fileId:fileName:3" → { fileId, fileName, pageNumber: 3 }', () => {
    const result = parseDocumentSideviewId('abc123:report.pdf:3')
    expect(result).toEqual({ fileId: 'abc123', fileName: 'report.pdf', pageNumber: 3 })
  })

  test('treats non-numeric suffix as part of filename', () => {
    const result = parseDocumentSideviewId('abc123:file:name:with:colons')
    expect(result).toEqual({ fileId: 'abc123', fileName: 'file:name:with:colons', pageNumber: undefined })
  })

  test('handles fileId only (no colon)', () => {
    const result = parseDocumentSideviewId('abc123')
    expect(result).toEqual({ fileId: 'abc123', fileName: 'document', pageNumber: undefined })
  })

  test('treats zero as non-page (not positive integer)', () => {
    const result = parseDocumentSideviewId('abc123:report.pdf:0')
    expect(result).toEqual({ fileId: 'abc123', fileName: 'report.pdf:0', pageNumber: undefined })
  })

  test('treats negative number as non-page', () => {
    const result = parseDocumentSideviewId('abc123:report.pdf:-1')
    expect(result).toEqual({ fileId: 'abc123', fileName: 'report.pdf:-1', pageNumber: undefined })
  })

  test('handles large page numbers', () => {
    const result = parseDocumentSideviewId('abc123:report.pdf:999')
    expect(result).toEqual({ fileId: 'abc123', fileName: 'report.pdf', pageNumber: 999 })
  })
})
