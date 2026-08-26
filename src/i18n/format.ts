/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AppLocale } from '@shared/i18n/locales'

/** What the display layer actually holds: epoch ms, an ISO 8601 string, or a `Date`. */
export type DateInput = number | string | Date

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/

/**
 * Coerce a display value to a `Date`.
 *
 * Bare `YYYY-MM-DD` gets an explicit midnight so it parses as *local* time:
 * `new Date('2026-08-26')` is UTC midnight, which renders as the 25th anywhere
 * west of Greenwich. Date-only strings reach us from the weather widget, and the
 * dayjs implementation this replaces parsed them as local.
 */
export const toDate = (value: DateInput): Date => {
  if (value instanceof Date) {
    return value
  }
  if (typeof value === 'number') {
    return new Date(value)
  }
  return new Date(dateOnlyPattern.test(value) ? `${value}T00:00:00` : value)
}

const second = 1000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour

/**
 * Largest unit first, so the first threshold a magnitude clears is the unit to
 * use — 90 minutes reads "2 hours ago" rather than "90 minutes ago".
 *
 * Month and year are CLDR's average lengths: `Intl.RelativeTimeFormat` takes a
 * count and a unit, not two dates, so there is no calendar-exact value to give
 * it.
 */
const relativeUnits: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * day],
  ['month', 30 * day],
  ['week', 7 * day],
  ['day', day],
  ['hour', hour],
  ['minute', minute],
  ['second', second],
]

const selectRelativeUnit = (deltaMs: number): { value: number; unit: Intl.RelativeTimeFormatUnit } => {
  const magnitude = Math.abs(deltaMs)
  const [unit, unitMs] = relativeUnits.find(([, ms]) => magnitude >= ms) ?? relativeUnits[relativeUnits.length - 1]
  // Rounded on the magnitude and re-signed, not rounded on the signed delta:
  // `Math.round` breaks .5 ties toward positive infinity, so the signed form
  // reads 90 minutes ago as "1 hour ago" while reading 90 minutes ahead as
  // "in 2 hours".
  return { value: Math.sign(deltaMs) * Math.round(magnitude / unitMs), unit }
}

export type Formatters = {
  /** An unambiguous absolute date: "Aug 26, 2026", "26. Aug. 2026", "2026年8月26日". */
  date: (value: DateInput) => string
  /** Weekday and day of month: "Wednesday, Aug 26". */
  weekdayDate: (value: DateInput) => string
  /** Abbreviated weekday on its own: "Wed". */
  weekday: (value: DateInput) => string
  /** "2 hours ago", "yesterday", "in 3 days". Past is negative, i.e. before `now`. */
  relativeTime: (value: DateInput, now?: Date) => string
  /** Abbreviated for tight spaces: "256K", "25,6 Mio.", "25.6万". */
  compactNumber: (value: number) => string
  /** Grouped in full: "1,234" / "1.234". */
  number: (value: number) => string
  /** An elapsed span, sub-second in milliseconds: "800ms", "1.5s", "1,5 s". */
  duration: (ms: number) => string
}

const createFormatters = (locale: AppLocale): Formatters => {
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const weekdayDateFormat = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'short', day: 'numeric' })
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short' })
  // `numeric: 'auto'` is what buys "yesterday" and "last month" over the
  // literal "1 day ago" — CLDR carries those phrasings per locale.
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const compactFormat = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const numberFormat = new Intl.NumberFormat(locale)
  const secondsFormat = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
  const millisecondsFormat = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'millisecond',
    unitDisplay: 'narrow',
    maximumFractionDigits: 0,
  })

  return {
    date: (value) => dateFormat.format(toDate(value)),
    weekdayDate: (value) => weekdayDateFormat.format(toDate(value)),
    weekday: (value) => weekdayFormat.format(toDate(value)),
    relativeTime: (value, now = new Date()) => {
      const { value: amount, unit } = selectRelativeUnit(toDate(value).getTime() - now.getTime())
      return relativeFormat.format(amount, unit)
    },
    compactNumber: (value) => compactFormat.format(value),
    number: (value) => numberFormat.format(value),
    duration: (ms) => (ms < second ? millisecondsFormat.format(ms) : secondsFormat.format(ms / second)),
  }
}

const cache = new Map<AppLocale, Formatters>()

/**
 * The formatting functions for a locale.
 *
 * Memoized because constructing an `Intl.*Format` is the expensive part, and
 * because a stable identity per locale makes the returned object safe to use as
 * a React dependency.
 *
 * Prefer `useFormatters()` in components — a render that formats has to
 * recompute when the locale changes, and a bare `getActiveLocale()` read will
 * not make it.
 */
export const getFormatters = (locale: AppLocale): Formatters => {
  const cached = cache.get(locale)
  if (cached) {
    return cached
  }
  const formatters = createFormatters(locale)
  cache.set(locale, formatters)
  return formatters
}
