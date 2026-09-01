/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { activeCurrencyCodes, unitDefaultsForRegion } from './region-units'

describe('unitDefaultsForRegion', () => {
  test('reads the two CLDR exception lists independently', () => {
    // Distance and temperature are separate CLDR categories, so the four
    // combinations all occur. The pre-THU-810 table modelled them as one field
    // and got LR, MM, GB, BS, BZ, KY, PR and PW wrong as a result.
    expect(unitDefaultsForRegion('US')).toMatchObject({ distanceUnit: 'imperial', temperatureUnit: 'f' })
    expect(unitDefaultsForRegion('GB')).toMatchObject({ distanceUnit: 'imperial', temperatureUnit: 'c' })
    expect(unitDefaultsForRegion('BS')).toMatchObject({ distanceUnit: 'metric', temperatureUnit: 'f' })
    expect(unitDefaultsForRegion('BR')).toMatchObject({ distanceUnit: 'metric', temperatureUnit: 'c' })
  })

  test('honors the CLDR overrides that put Liberia and Myanmar back on Celsius', () => {
    expect(unitDefaultsForRegion('LR')).toMatchObject({ distanceUnit: 'imperial', temperatureUnit: 'c' })
    expect(unitDefaultsForRegion('MM')).toMatchObject({ distanceUnit: 'imperial', temperatureUnit: 'c' })
  })

  test('derives the hour cycle from the region', () => {
    expect(unitDefaultsForRegion('US').timeFormat).toBe('12h')
    expect(unitDefaultsForRegion('DE').timeFormat).toBe('24h')
    expect(unitDefaultsForRegion('JP').timeFormat).toBe('24h')
    expect(unitDefaultsForRegion('IN').timeFormat).toBe('12h')
  })

  test('resolves the hour cycle on a tag with no script subtag', () => {
    // Regression guard for `tagForRegion`. ICU keys hour-cycle data on
    // `language-REGION`, so a maximized tag misses: `en-Latn-GB` resolves to
    // h12 and `es-Latn-MX` to h23 — both the opposite of the truth.
    expect(unitDefaultsForRegion('GB').timeFormat).toBe('24h')
    expect(unitDefaultsForRegion('MX').timeFormat).toBe('12h')
  })

  test('maps the region to its circulating currency', () => {
    expect(unitDefaultsForRegion('BR').currency).toBe('BRL')
    expect(unitDefaultsForRegion('JP').currency).toBe('JPY')
    expect(unitDefaultsForRegion('DE').currency).toBe('EUR')
    // Bulgaria adopted the euro on 2026-01-01; the retired JSON still said BGN.
    expect(unitDefaultsForRegion('BG').currency).toBe('EUR')
  })

  test('covers regions across every continent without silently falling back', () => {
    // A typo'd key is invisible at runtime — the region just gets US defaults.
    const spread = {
      AU: 'AUD',
      CA: 'CAD',
      CH: 'CHF',
      CN: 'CNY',
      EG: 'EGP',
      IN: 'INR',
      KE: 'KES',
      KR: 'KRW',
      MX: 'MXN',
      NG: 'NGN',
      NO: 'NOK',
      PL: 'PLN',
      SE: 'SEK',
      TR: 'TRY',
      ZA: 'ZAR',
    }
    for (const [region, currency] of Object.entries(spread)) {
      expect([region, unitDefaultsForRegion(region).currency]).toEqual([region, currency])
    }
  })

  test('accepts a lowercase region', () => {
    expect(unitDefaultsForRegion('br')).toEqual(unitDefaultsForRegion('BR'))
  })

  test('falls back to US for a region CLDR does not know', () => {
    expect(unitDefaultsForRegion('ZZ')).toEqual(unitDefaultsForRegion('US'))
    expect(unitDefaultsForRegion('')).toEqual(unitDefaultsForRegion('US'))
  })
})

const coOfficialTenders = ['BTN', 'HTG', 'NAD', 'PAB', 'ZWG']

describe('activeCurrencyCodes', () => {
  test('lists every circulating currency, sorted and deduplicated', () => {
    // A deliberate "did you mean to change the list?" gate, like `defaultSettingsVersion`.
    // 148 region defaults, plus whichever co-official tenders this engine can name —
    // ZWG is missing from older ICU builds, so the total is deliberately not fixed.
    const nameable = coOfficialTenders.filter((code) => new Set(Intl.supportedValuesOf('currency')).has(code))
    expect(activeCurrencyCodes.length).toBe(148 + nameable.length)
    expect([...activeCurrencyCodes].sort()).toEqual([...activeCurrencyCodes])
    expect(new Set(activeCurrencyCodes).size).toBe(activeCurrencyCodes.length)
  })

  // A region whose CLDR entry lists two current tenders defaults to the one in
  // everyday use, but the other must still be selectable — otherwise a user in
  // Bhutan or Namibia cannot reach their own currency at all.
  test('offers the co-official tender of two-currency regions', () => {
    const supported = new Set(Intl.supportedValuesOf('currency'))
    for (const code of coOfficialTenders.filter((c) => supported.has(c))) {
      expect(activeCurrencyCodes).toContain(code)
    }
  })

  test('holds ISO 4217 codes only', () => {
    expect(activeCurrencyCodes.filter((code) => !/^[A-Z]{3}$/.test(code))).toEqual([])
  })

  test('excludes the defunct currencies Intl still enumerates', () => {
    // `Intl.supportedValuesOf('currency')` returns 307 codes including these.
    expect(activeCurrencyCodes).not.toContain('ADP')
    expect(activeCurrencyCodes).not.toContain('AOK')
    expect(Intl.supportedValuesOf('currency').length).toBeGreaterThan(activeCurrencyCodes.length)
  })

  test('is a strict subset of what Intl can format', () => {
    const supported = new Set(Intl.supportedValuesOf('currency'))
    expect(activeCurrencyCodes.filter((code) => !supported.has(code))).toEqual([])
  })
})
