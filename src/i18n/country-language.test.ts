/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { localeForRegion } from './country-language'

describe('localeForRegion', () => {
  // The geocoding provider's `country_code` reaches here untyped beyond `string`.
  // `Intl.Locale` throws `RangeError` on anything that isn't a well-formed tag,
  // and the throw would surface as a confirm dialog that never opens.
  test('returns null for anything that is not an alpha-2 region', () => {
    for (const bad of ['', 'USA', 'Brazil', 'u', '12', 'BR-SP', ' BR']) {
      expect(localeForRegion(bad)).toBeNull()
    }
  })

  test('maps a region to the shipped locale of its dominant language', () => {
    expect(localeForRegion('DE')).toBe('de')
    expect(localeForRegion('FR')).toBe('fr')
    expect(localeForRegion('MX')).toBe('es')
    expect(localeForRegion('JP')).toBe('ja')
  })

  test('maps regional variants onto the shipped locale', () => {
    expect(localeForRegion('PT')).toBe('pt-BR')
    expect(localeForRegion('AT')).toBe('de')
    expect(localeForRegion('GB')).toBe('en')
  })

  test('returns null when the app ships no catalog for the language', () => {
    expect(localeForRegion('IT')).toBeNull()
    expect(localeForRegion('PL')).toBeNull()
  })

  test('returns null when the provider gave no region', () => {
    expect(localeForRegion('')).toBeNull()
  })
})
