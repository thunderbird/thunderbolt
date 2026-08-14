/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, test } from 'bun:test'

import {
  defaultDeliveryMode,
  docxMime,
  getTransformer,
  hasTransformer,
  isPlainTextMime,
  resolveTextMimeType,
} from './index'

describe('transformer registry', () => {
  test('hasTransformer reports registered source→target pairs', () => {
    expect(hasTransformer('application/pdf', 'text')).toBe(true)
    expect(hasTransformer(docxMime, 'text')).toBe(true)
    expect(hasTransformer('application/pdf', 'images')).toBe(true)
  })

  test('plain-text types resolve to the passthrough text transformer (no explicit entry)', () => {
    expect(hasTransformer('text/csv', 'text')).toBe(true)
    expect(hasTransformer('text/plain', 'text')).toBe(true)
    expect(hasTransformer('application/json', 'text')).toBe(true)
  })

  test('hasTransformer is false for unregistered pairs', () => {
    expect(hasTransformer('image/png', 'text')).toBe(false)
    expect(hasTransformer('', 'text')).toBe(false)
    // Plain-text passthrough is text-only — no images target.
    expect(hasTransformer('text/csv', 'images')).toBe(false)
    // docx has a text transformer but not an images one.
    expect(hasTransformer(docxMime, 'images')).toBe(false)
  })

  test('getTransformer lazy-loads a callable transformer for a known type', async () => {
    const pdf = await getTransformer('application/pdf', 'text')
    const docx = await getTransformer(docxMime, 'text')
    const csv = await getTransformer('text/csv', 'text')
    expect(typeof pdf).toBe('function')
    expect(typeof docx).toBe('function')
    expect(typeof csv).toBe('function')
  })

  test('getTransformer resolves to null for an unknown type', async () => {
    expect(await getTransformer('image/png', 'text')).toBeNull()
  })

  test('defaultDeliveryMode: plain text → text, rich/binary → native (undefined)', () => {
    expect(defaultDeliveryMode('text/csv')).toBe('text')
    expect(defaultDeliveryMode('application/json')).toBe('text')
    expect(defaultDeliveryMode('application/pdf')).toBeUndefined()
    expect(defaultDeliveryMode(docxMime)).toBeUndefined()
    expect(defaultDeliveryMode('image/png')).toBeUndefined()
  })

  test('isPlainTextMime covers text/* and json, excludes pdf/docx', () => {
    expect(isPlainTextMime('text/markdown')).toBe(true)
    expect(isPlainTextMime('application/json')).toBe(true)
    expect(isPlainTextMime('application/pdf')).toBe(false)
    expect(isPlainTextMime(docxMime)).toBe(false)
  })
})

describe('resolveTextMimeType', () => {
  it('trusts a declared type we can already handle', () => {
    expect(resolveTextMimeType('a.pdf', 'application/pdf')).toBe('application/pdf')
    expect(resolveTextMimeType('a.md', 'text/markdown')).toBe('text/markdown')
  })

  it.each([
    ['notes.md', ''],
    ['README.markdown', ''],
    ['log.txt', ''],
    ['rows.csv', ''],
  ])('resolves %s (declared "%s") to text/plain', (filename, declared) => {
    expect(resolveTextMimeType(filename, declared)).toBe('text/plain')
  })

  it('leaves a genuinely binary type alone', () => {
    expect(resolveTextMimeType('photo.png', 'image/png')).toBe('image/png')
    expect(resolveTextMimeType('archive.zip', '')).toBe('')
    expect(resolveTextMimeType('Makefile', '')).toBe('')
  })

  it('leaves an extension the composer does not accept alone', () => {
    // The set is scoped to the accept list; resolving a type that cannot be
    // attached would imply support that isn't there.
    expect(resolveTextMimeType('script.py', '')).toBe('')
    expect(resolveTextMimeType('config.yaml', '')).toBe('')
  })

  it('makes resolved text files deliver as text, not native bytes', () => {
    // The whole point: an unresolved empty MIME would route to native delivery,
    // which a model cannot read.
    expect(defaultDeliveryMode(resolveTextMimeType('notes.md', ''))).toBe('text')
    expect(defaultDeliveryMode('')).toBeUndefined()
  })

  it('has a text transformer for every resolved extension', async () => {
    for (const extension of ['md', 'markdown', 'txt', 'csv', 'json']) {
      expect(hasTransformer(resolveTextMimeType(`f.${extension}`, ''), 'text')).toBe(true)
    }
  })
})
