/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { getUnitLabels } from './unit-labels'

// The system names ("Metric", "Celsius") come from the catalog, and bun's
// identity macro mock renders the English source, so only the `Intl` half of
// each label varies by locale here. That half is the half that used to be
// hardcoded English in a backend JSON.

describe('distance', () => {
  test('pairs the system name with its unit symbol', () => {
    expect(getUnitLabels('en').distance('metric')).toBe('Metric (km)')
    expect(getUnitLabels('en').distance('imperial')).toBe('Imperial (mi)')
  })

  test('uses the short symbol, which every locale abbreviates', () => {
    // Narrow would give "マイル" and "milha" here — CLDR only abbreviates
    // "mile" in the short form for these locales.
    expect(getUnitLabels('ja').distance('imperial')).toBe('Imperial (mi)')
    expect(getUnitLabels('pt-BR').distance('imperial')).toBe('Imperial (mi)')
  })
})

describe('temperature', () => {
  test('pairs the system name with its degree symbol', () => {
    expect(getUnitLabels('en').temperature('c')).toBe('Celsius (°C)')
    expect(getUnitLabels('en').temperature('f')).toBe('Fahrenheit (°F)')
  })

  test('keeps the F in Fahrenheit', () => {
    // Regression guard for `unitDisplay`. English narrows fahrenheit to a bare
    // "°" because US context makes it inferable, which would render the label
    // "Fahrenheit (°)" and make the two options indistinguishable by symbol.
    for (const locale of ['en', 'de', 'fr', 'es', 'pt-BR', 'ja'] as const) {
      expect([locale, getUnitLabels(locale).temperature('f')]).toEqual([locale, 'Fahrenheit (°F)'])
    }
  })
})

describe('currency', () => {
  test('translates the name', () => {
    expect(getUnitLabels('en').currency('BRL')).toBe('Brazilian Real (R$)')
    expect(getUnitLabels('de').currency('BRL')).toBe('Brasilianischer Real (R$)')
    expect(getUnitLabels('ja').currency('BRL')).toBe('ブラジル レアル (R$)')
  })

  test('localizes the symbol too', () => {
    // The retired JSON shipped one static symbol per currency. Symbols are
    // locale-dependent: Brazilian Portuguese disambiguates the US dollar from
    // its own real.
    expect(getUnitLabels('en').currency('USD')).toBe('US Dollar ($)')
    expect(getUnitLabels('pt-BR').currency('USD')).toBe('Dólar americano (US$)')
  })

  test('falls back to the code for currencies with no symbol', () => {
    expect(getUnitLabels('en').currency('AED')).toBe('United Arab Emirates Dirham (AED)')
  })

  test('still renders a currency that is no longer a region default', () => {
    // Bulgaria moved to the euro, so BGN is off `activeCurrencyCodes` — but a
    // user who picked it before still has it stored.
    expect(getUnitLabels('en').currency('BGN')).toBe('Bulgarian Lev (BGN)')
  })
})

describe('timeFormat', () => {
  test('renders an example rather than the stored token', () => {
    expect(getUnitLabels('en').timeFormat('12h')).toBe('1:30 PM')
    expect(getUnitLabels('en').timeFormat('24h')).toBe('13:30')
  })

  test('follows the locale into the example', () => {
    expect(getUnitLabels('ja').timeFormat('12h')).toBe('午後1:30')
    expect(getUnitLabels('de').timeFormat('24h')).toBe('13:30')
  })

  test('picks an hour the two formats disagree on', () => {
    const labels = getUnitLabels('en')
    expect(labels.timeFormat('12h')).not.toBe(labels.timeFormat('24h'))
  })
})

describe('getUnitLabels', () => {
  test('memoizes per locale', () => {
    expect(getUnitLabels('de')).toBe(getUnitLabels('de'))
    expect(getUnitLabels('de')).not.toBe(getUnitLabels('fr'))
  })
})
