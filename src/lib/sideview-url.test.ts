import { describe, expect, test } from 'bun:test'
import { parseSideviewParam } from './sideview-url'

describe('parseSideviewParam', () => {
  test('parses valid sideview param', () => {
    const url = new URL('http://example.com?sideview=message:abc123')
    const result = parseSideviewParam(url)

    expect(result).toEqual({
      type: 'message',
      id: 'abc123',
    })
  })

  test('decodes URL-encoded id', () => {
    const url = new URL('http://example.com?sideview=thread:some%20id%20with%20spaces')
    const result = parseSideviewParam(url)

    expect(result).toEqual({
      type: 'thread',
      id: 'some id with spaces',
    })
  })

  test('handles special characters in id', () => {
    const url = new URL('http://example.com?sideview=imap:folder%2Fsubfolder')
    const result = parseSideviewParam(url)

    expect(result).toEqual({
      type: 'imap',
      id: 'folder/subfolder',
    })
  })

  test('returns nulls when param is missing', () => {
    const url = new URL('http://example.com')
    const result = parseSideviewParam(url)

    expect(result).toEqual({
      type: null,
      id: null,
    })
  })

  test('returns nulls when param has no colon', () => {
    const url = new URL('http://example.com?sideview=invalid')
    const result = parseSideviewParam(url)

    expect(result).toEqual({
      type: null,
      id: null,
    })
  })

  test('returns nulls when type is missing', () => {
    const url = new URL('http://example.com?sideview=:abc123')
    const result = parseSideviewParam(url)

    expect(result).toEqual({
      type: null,
      id: null,
    })
  })

  test('returns nulls when id is missing', () => {
    const url = new URL('http://example.com?sideview=message:')
    const result = parseSideviewParam(url)

    expect(result).toEqual({
      type: null,
      id: null,
    })
  })

  test('handles multiple colons by splitting on first colon only', () => {
    const url = new URL('http://example.com?sideview=message:id:with:colons')
    const result = parseSideviewParam(url)

    expect(result).toEqual({
      type: 'message',
      id: 'id:with:colons',
    })
  })
})
