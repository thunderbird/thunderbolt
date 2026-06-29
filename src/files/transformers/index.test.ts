/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'

import { docxMime, getTransformer, hasTransformer } from './index'

describe('transformer registry', () => {
  test('hasTransformer reports registered source→target pairs', () => {
    expect(hasTransformer('application/pdf', 'text')).toBe(true)
    expect(hasTransformer(docxMime, 'text')).toBe(true)
    expect(hasTransformer('application/pdf', 'images')).toBe(true)
  })

  test('hasTransformer is false for unregistered pairs', () => {
    expect(hasTransformer('image/png', 'text')).toBe(false)
    expect(hasTransformer('text/plain', 'text')).toBe(false)
    expect(hasTransformer('', 'text')).toBe(false)
    // docx has a text transformer but not an images one.
    expect(hasTransformer(docxMime, 'images')).toBe(false)
  })

  test('getTransformer lazy-loads a callable transformer for a known type', async () => {
    const pdf = await getTransformer('application/pdf', 'text')
    const docx = await getTransformer(docxMime, 'text')
    expect(typeof pdf).toBe('function')
    expect(typeof docx).toBe('function')
  })

  test('getTransformer resolves to null for an unknown type', async () => {
    expect(await getTransformer('image/png', 'text')).toBeNull()
  })
})
