/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { AppLocale } from '@shared/i18n/locales'
import { i18n } from '@/i18n'
import { getFormatters } from './format'
import type { DistanceUnit, TemperatureUnit, TimeFormat } from './region-units'

/**
 * System names, as descriptors resolved at call time. `Intl` has no API for
 * these: `DisplayNames` covers languages, regions, scripts and currencies but
 * not units, and `NumberFormat`'s long unit display embeds the name in a
 * pattern around the number — Japanese splits "摂氏20度" into two parts, so
 * there is no name to lift out of `formatToParts`.
 */
const distanceNames = {
  metric: msg`Metric`,
  imperial: msg`Imperial`,
} satisfies Record<DistanceUnit, MessageDescriptor>

const temperatureNames = {
  c: msg`Celsius`,
  f: msg`Fahrenheit`,
} satisfies Record<TemperatureUnit, MessageDescriptor>

const distanceUnits = { metric: 'kilometer', imperial: 'mile' } as const
const temperatureUnits = { c: 'celsius', f: 'fahrenheit' } as const

/** 13:30 — the one hour that reads differently in the two time formats. */
const timeExample = new Date(2000, 0, 1, 13, 30)

/**
 * The unit symbol on its own. `formatToParts` is the only way to get it: every
 * `format` call attaches a number.
 *
 * `short`, not `narrow`. Narrow is for contexts where the unit is inferable
 * from its surroundings, which is the opposite of a label whose job is to
 * disambiguate — English narrows Fahrenheit to a bare "°", and Japanese and
 * Portuguese spell "mile" out in full. Short gives "°F" and "mi" in all six
 * locales.
 */
const unitSymbol = (locale: AppLocale, unit: string): string =>
  new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' })
    .formatToParts(0)
    .filter((part) => part.type === 'unit')
    .map((part) => part.value)
    .join('')

export type UnitLabels = {
  /** "Metric (km)" / "Imperial (mi)" */
  distance: (value: DistanceUnit) => string
  /** "Celsius (°C)" / "Fahrenheit (°F)" */
  temperature: (value: TemperatureUnit) => string
  /** "Brazilian Real (R$)" — the name and the symbol both follow the locale. */
  currency: (code: string) => string
  /** A rendered example rather than the stored token: "1:30 PM" / "13:30". */
  timeFormat: (value: TimeFormat) => string
}

const createUnitLabels = (locale: AppLocale): UnitLabels => {
  const currencyNames = new Intl.DisplayNames([locale], { type: 'currency' })
  const { time } = getFormatters(locale)

  return {
    distance: (value) => `${i18n._(distanceNames[value])} (${unitSymbol(locale, distanceUnits[value])})`,
    temperature: (value) => `${i18n._(temperatureNames[value])} (${unitSymbol(locale, temperatureUnits[value])})`,
    currency: (code) => {
      // Locale-dependent, unlike the symbol the retired JSON shipped: pt-BR
      // writes USD as "US$" where en writes "$". Currencies with no symbol of
      // their own fall back to their code, which is what we want to show.
      const symbol = new Intl.NumberFormat(locale, { style: 'currency', currency: code })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value
      return `${currencyNames.of(code)} (${symbol ?? code})`
    },
    timeFormat: (value) => time(timeExample, { hour12: value === '12h' }),
  }
}

const cache = new Map<AppLocale, UnitLabels>()

/**
 * Option labels for the unit settings, in a locale.
 *
 * Memoized on the same reasoning as `getFormatters`: constructing the `Intl`
 * instances is the expensive part, and the currency picker calls `currency()`
 * once per circulating currency. The descriptors resolve against the live
 * catalog inside each function, so a memoized object still follows a language
 * change.
 */
export const getUnitLabels = (locale: AppLocale): UnitLabels => {
  const cached = cache.get(locale)
  if (cached) {
    return cached
  }
  const labels = createUnitLabels(locale)
  cache.set(locale, labels)
  return labels
}
