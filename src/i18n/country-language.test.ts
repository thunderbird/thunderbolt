/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { countryCodeFromName, localeForCountry } from './country-language'

describe('countryCodeFromName', () => {
  test('resolves CLDR region names', () => {
    expect(countryCodeFromName('Germany')).toBe('DE')
    expect(countryCodeFromName('Brazil')).toBe('BR')
  })

  test('ignores case, accents and punctuation', () => {
    expect(countryCodeFromName('  japan ')).toBe('JP')
    expect(countryCodeFromName("Cote d'Ivoire")).toBe('CI')
  })

  test('returns null for anything that is not a country name', () => {
    expect(countryCodeFromName('Bavaria')).toBeNull()
    expect(countryCodeFromName('')).toBeNull()
  })
})

describe('localeForCountry', () => {
  test('maps a country to the shipped locale of its dominant language', () => {
    expect(localeForCountry('Germany')).toBe('de')
    expect(localeForCountry('France')).toBe('fr')
    expect(localeForCountry('Mexico')).toBe('es')
    expect(localeForCountry('Japan')).toBe('ja')
  })

  test('maps regional variants onto the shipped locale', () => {
    expect(localeForCountry('Portugal')).toBe('pt-BR')
    expect(localeForCountry('Austria')).toBe('de')
    expect(localeForCountry('United Kingdom')).toBe('en')
  })

  test('returns null when the app ships no catalog for the language', () => {
    expect(localeForCountry('Italy')).toBeNull()
    expect(localeForCountry('Poland')).toBeNull()
  })

  test('returns null for an unrecognized country', () => {
    expect(localeForCountry('Atlantis')).toBeNull()
  })
})
