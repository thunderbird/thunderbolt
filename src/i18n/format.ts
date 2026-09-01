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
 * west of Greenwich. Date-only strings reach us from the weather widget, whose
 * snapshots pin the expected day.
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

/** How many of `relativeUnits[index]` fill the next unit up — 60 minutes to an
 *  hour, 12 months to a year. Derived rather than tabulated so it stays true if
 *  a unit is added. */
const fillsNextUnit = (index: number): number => Math.round(relativeUnits[index - 1][1] / relativeUnits[index][1])

const selectRelativeUnit = (deltaMs: number): { value: number; unit: Intl.RelativeTimeFormatUnit } => {
  const magnitude = Math.abs(deltaMs)
  const found = relativeUnits.findIndex(([, ms]) => magnitude >= ms)
  const index = found === -1 ? relativeUnits.length - 1 : found
  // The unit is chosen on the raw magnitude but the count is rounded, so a
  // magnitude just under a boundary overflows its own band: 59.5 minutes picks
  // `minute` and then rounds to 60, printing "60 minutes ago" where the whole
  // point of `numeric: 'auto'` is "an hour ago". Step up when the rounded count
  // fills the next unit. Comparing counts rather than milliseconds matters at
  // the top: 12 rounded months is a year even though 12 × 30 days is not 365.
  const overflows = index > 0 && Math.round(magnitude / relativeUnits[index][1]) >= fillsNextUnit(index)
  const [unit, unitMs] = relativeUnits[overflows ? index - 1 : index]
  // Rounded on the magnitude and re-signed, not rounded on the signed delta:
  // `Math.round` breaks .5 ties toward positive infinity, so the signed form
  // reads 90 minutes ago as "1 hour ago" while reading 90 minutes ahead as
  // "in 2 hours".
  return { value: Math.sign(deltaMs) * Math.round(magnitude / unitMs), unit }
}

export type Formatters = {
  /** An unambiguous absolute date: "Aug 26, 2026", "26.08.2026", "2026/08/26". */
  date: (value: DateInput) => string
  /** Weekday and day of month: "Wednesday, Aug 26". */
  weekdayDate: (value: DateInput) => string
  /** Abbreviated weekday on its own: "Wed". */
  weekday: (value: DateInput) => string
  /** "2 hours ago", "yesterday", "in 3 days". Past is negative, i.e. before `now`. */
  relativeTime: (value: DateInput, now?: Date) => string
  /**
   * A clock time: "1:30 PM", "13:30", "午後1:30".
   *
   * `hour12` is required rather than defaulted, because the choice is the
   * user's `time_format` setting and not the locale's convention — the two are
   * independent, and an en-US user preferring 24-hour is the whole point of
   * having the setting.
   */
  time: (value: DateInput, options: { hour12: boolean }) => string
  /** Abbreviated for tight spaces: "256K", "256.000", "25.6万" — German and
   *  Japanese do not abbreviate thousands, so expect this to get wider. */
  compactNumber: (value: number) => string
  /** Grouped in full: "1,234" / "1.234". */
  number: (value: number) => string
  /** An elapsed span, sub-second in milliseconds: "800ms", "1.5s", "1,5s" —
   *  only the number is localized, the unit is the SI symbol. */
  duration: (ms: number) => string
}

const createFormatters = (locale: AppLocale): Formatters => {
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const weekdayDateFormat = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'short', day: 'numeric' })
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short' })
  // `numeric: 'auto'` is what buys "yesterday" and "last month" over the
  // literal "1 day ago" — CLDR carries those phrasings per locale.
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const timeFormats = {
    true: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: true }),
    false: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: false }),
  }
  const compactFormat = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const numberFormat = new Intl.NumberFormat(locale)
  // The number is localized; the unit is the SI symbol, appended by us. This is
  // the one place the layer does not let CLDR name a unit, and it is deliberate:
  // `unitDisplay: 'narrow'` for seconds is not stable across ICU builds, so the
  // same code renders German as "1,5s" on ICU 74 and "1,5 Sek." on ICU 78, and
  // Japanese loses 秒 going the other way. That variance reaches users through
  // whatever ICU their browser ships, and it made a hardcoded test assertion
  // pass locally while failing in CI on the same pinned Bun version. `s` and
  // `ms` are SI symbols rather than English words, and this is a latency
  // readout in a tight space, so a fixed suffix is both stabler and narrower.
  // `useGrouping: false` because a duration is a stopwatch reading, not a
  // quantity: the old `formatDuration` produced `3600.0s`, and grouping would
  // silently turn that into `3,600.0s`.
  const secondsFormat = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  })
  const millisecondsFormat = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    useGrouping: false,
  })

  return {
    date: (value) => dateFormat.format(toDate(value)),
    weekdayDate: (value) => weekdayDateFormat.format(toDate(value)),
    weekday: (value) => weekdayFormat.format(toDate(value)),
    relativeTime: (value, now = new Date()) => {
      const { value: amount, unit } = selectRelativeUnit(toDate(value).getTime() - now.getTime())
      return relativeFormat.format(amount, unit)
    },
    time: (value, { hour12 }) => timeFormats[hour12 ? 'true' : 'false'].format(toDate(value)),
    compactNumber: (value) => compactFormat.format(value),
    number: (value) => numberFormat.format(value),
    // Rounded before the branch is chosen, for the same reason `selectRelativeUnit`
    // promotes: 999.6ms rounds to 1000 and would otherwise print `1000ms`, not `1.0s`.
    duration: (ms) =>
      Math.round(ms) < second ? `${millisecondsFormat.format(ms)}ms` : `${secondsFormat.format(ms / second)}s`,
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
