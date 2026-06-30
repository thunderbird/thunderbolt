/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'

import { defaultDeliveryMode, docxMime, getTransformer, hasTransformer, isPlainTextMime } from './index'

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
