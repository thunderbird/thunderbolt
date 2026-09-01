/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { getFormatters, toDate } from './format'

const now = new Date('2026-08-26T12:00:00Z')
const offsetBy = (ms: number): string => new Date(now.getTime() + ms).toISOString()

const second = 1000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour

describe('toDate', () => {
  test('parses a bare YYYY-MM-DD as local midnight', () => {
    const parsed = toDate('2026-08-26')
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(7)
    expect(parsed.getDate()).toBe(26)
    expect(parsed.getHours()).toBe(0)
  })

  test('parses an ISO timestamp, epoch ms, and Date alike', () => {
    const expected = new Date('2026-08-26T12:00:00Z').getTime()
    expect(toDate('2026-08-26T12:00:00Z').getTime()).toBe(expected)
    expect(toDate(expected).getTime()).toBe(expected)
    expect(toDate(new Date(expected)).getTime()).toBe(expected)
  })
})

describe('relativeTime', () => {
  const en = getFormatters('en')

  test('collapses sub-second deltas to the present', () => {
    expect(en.relativeTime(offsetBy(-400), now)).toBe('now')
    expect(en.relativeTime(now, now)).toBe('now')
  })

  test('picks the largest unit the delta clears', () => {
    expect(en.relativeTime(offsetBy(-30 * second), now)).toBe('30 seconds ago')
    expect(en.relativeTime(offsetBy(-5 * minute), now)).toBe('5 minutes ago')
    expect(en.relativeTime(offsetBy(-3 * hour), now)).toBe('3 hours ago')
    expect(en.relativeTime(offsetBy(-3 * day), now)).toBe('3 days ago')
    expect(en.relativeTime(offsetBy(-10 * day), now)).toBe('last week')
    expect(en.relativeTime(offsetBy(-60 * day), now)).toBe('2 months ago')
    expect(en.relativeTime(offsetBy(-400 * day), now)).toBe('last year')
  })

  test('rounds past and future symmetrically', () => {
    expect(en.relativeTime(offsetBy(-90 * minute), now)).toBe('2 hours ago')
    expect(en.relativeTime(offsetBy(90 * minute), now)).toBe('in 2 hours')
  })

  // Rounding used to overflow the band it was chosen in, so a delta just short
  // of the next unit printed "60 minutes ago" instead of "an hour ago".
  test('steps up when rounding fills the next unit', () => {
    // `numeric: 'auto'` only carries idiomatic phrasing from `day` upward, so
    // the win here is "1 hour ago" over "60 minutes ago", not "an hour ago".
    expect(en.relativeTime(offsetBy(-59.5 * minute), now)).toBe('1 hour ago')
    expect(en.relativeTime(offsetBy(-23.6 * hour), now)).toBe('yesterday')
    expect(en.relativeTime(offsetBy(23.6 * hour), now)).toBe('tomorrow')
    expect(en.relativeTime(offsetBy(-6.6 * day), now)).toBe('last week')
    expect(en.relativeTime(offsetBy(-3.6 * 7 * day), now)).toBe('last month')
    expect(en.relativeTime(offsetBy(-364 * day), now)).toBe('last year')
  })

  test('uses CLDR phrasing rather than a literal count', () => {
    expect(en.relativeTime(offsetBy(-26 * hour), now)).toBe('yesterday')
    expect(en.relativeTime(offsetBy(26 * hour), now)).toBe('tomorrow')
  })

  test('translates the whole phrase, not just the number', () => {
    expect(getFormatters('de').relativeTime(offsetBy(-3 * hour), now)).toBe('vor 3 Stunden')
    expect(getFormatters('pt-BR').relativeTime(offsetBy(-3 * hour), now)).toBe('há 3 horas')
    expect(getFormatters('ja').relativeTime(offsetBy(-3 * hour), now)).toBe('3 時間前')
  })
})

describe('numbers', () => {
  test('abbreviates in English', () => {
    expect(getFormatters('en').compactNumber(256_000)).toBe('256K')
    expect(getFormatters('en').compactNumber(1_500_000)).toBe('1.5M')
  })

  // German short-form compact has no abbreviation below a million, so the
  // indicator that reads "256K" in English reads "256.000" here.
  test('follows each locale on abbreviation and separators', () => {
    expect(getFormatters('de').compactNumber(256_000)).toBe('256.000')
    // \u00A0 is CLDR's own separator here, not a plain space.
    expect(getFormatters('de').compactNumber(1_500_000)).toBe('1,5\u00A0Mio.')
    expect(getFormatters('ja').compactNumber(256_000)).toBe('25.6万')
  })

  test('groups full numbers per locale', () => {
    expect(getFormatters('en').number(1_234_567)).toBe('1,234,567')
    expect(getFormatters('de').number(1_234_567)).toBe('1.234.567')
  })
})

describe('duration', () => {
  test('stays in milliseconds below a second', () => {
    expect(getFormatters('en').duration(800)).toBe('800ms')
    expect(getFormatters('en').duration(999)).toBe('999ms')
  })

  // A duration is a stopwatch reading, not a quantity — the old `formatDuration`
  // never grouped, and 999.6ms must promote rather than print "1000ms".
  test('never groups digits, and promotes at the rounding boundary', () => {
    expect(getFormatters('en').duration(3_600_000)).toBe('3600.0s')
    expect(getFormatters('de').duration(3_600_000)).toBe('3600,0s')
    expect(getFormatters('en').duration(999.6)).toBe('1.0s')
    expect(getFormatters('en').duration(999)).toBe('999ms')
  })

  test('switches to seconds at a second', () => {
    expect(getFormatters('en').duration(1000)).toBe('1.0s')
    expect(getFormatters('en').duration(2500)).toBe('2.5s')
  })

  // Only the number is localized. The unit is our own SI symbol precisely so
  // this assertion is stable: CLDR's narrow second differs between ICU builds,
  // so pinning it here passed locally and failed in CI on the same Bun version.
  test('localizes the decimal separator but not the unit', () => {
    expect(getFormatters('de').duration(1500)).toBe('1,5s')
    expect(getFormatters('ja').duration(1500)).toBe('1.5s')
    expect(getFormatters('de').duration(800)).toBe('800ms')
  })
})

describe('dates', () => {
  test('renders a date-only string on the day it names', () => {
    expect(getFormatters('en').weekday('2026-08-26')).toBe('Wed')
    expect(getFormatters('en').weekdayDate('2026-08-26')).toBe('Wednesday, Aug 26')
  })

  test('orders date parts per locale', () => {
    expect(getFormatters('en').date('2026-08-26')).toBe('Aug 26, 2026')
    expect(getFormatters('de').date('2026-08-26')).toBe('26.08.2026')
    expect(getFormatters('ja').date('2026-08-26')).toBe('2026/08/26')
  })
})

describe('time', () => {
  // Built from local parts, and formatted without a `timeZone`, so the
  // rendered clock matches the constructor arguments in any zone.
  const halfPastOne = new Date(2000, 0, 1, 13, 30)

  test('honors the requested hour cycle over the locale convention', () => {
    expect(getFormatters('en').time(halfPastOne, { hour12: true })).toBe('1:30 PM')
    expect(getFormatters('en').time(halfPastOne, { hour12: false })).toBe('13:30')
    // German defaults to 24-hour; the setting still wins.
    expect(getFormatters('de').time(halfPastOne, { hour12: true })).toBe('1:30 PM')
    expect(getFormatters('de').time(halfPastOne, { hour12: false })).toBe('13:30')
  })

  test('localizes the day period', () => {
    expect(getFormatters('ja').time(halfPastOne, { hour12: true })).toBe('午後1:30')
  })

  test('renders midnight and noon unambiguously', () => {
    const midnight = new Date(2000, 0, 1, 0, 5)
    const noon = new Date(2000, 0, 1, 12, 5)
    expect(getFormatters('en').time(midnight, { hour12: true })).toBe('12:05 AM')
    expect(getFormatters('en').time(midnight, { hour12: false })).toBe('00:05')
    expect(getFormatters('en').time(noon, { hour12: true })).toBe('12:05 PM')
    expect(getFormatters('en').time(noon, { hour12: false })).toBe('12:05')
  })
})

describe('getFormatters', () => {
  test('returns a stable object per locale so it is safe as a React dependency', () => {
    expect(getFormatters('fr')).toBe(getFormatters('fr'))
    expect(getFormatters('fr')).not.toBe(getFormatters('es'))
  })
})
