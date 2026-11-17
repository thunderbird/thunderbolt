/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { toDayInput, toRangeEnd, toRangeStart } from './audit-date-range'

describe('audit date range', () => {
  it('starts a day at local midnight', () => {
    const start = new Date(toRangeStart('2026-11-17'))
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()]).toEqual([
      2026, 10, 17, 0, 0,
    ])
  })

  it('ends a day at its last local millisecond', () => {
    const end = new Date(toRangeEnd('2026-11-17'))
    expect([end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([
      17, 23, 59, 59, 999,
    ])
  })

  it('reads both bounds back as the same day', () => {
    expect(toDayInput(toRangeStart('2026-02-28'))).toBe('2026-02-28')
    expect(toDayInput(toRangeEnd('2026-02-28'))).toBe('2026-02-28')
  })

  it('shows nothing for a missing or unreadable bound', () => {
    expect(toDayInput(undefined)).toBe('')
    expect(toDayInput('not-a-date')).toBe('')
  })
})
