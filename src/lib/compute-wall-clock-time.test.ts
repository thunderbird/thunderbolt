/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { computeWallClockTime } from './utils'

describe('computeWallClockTime', () => {
  it('returns 0 for empty intervals', () => {
    expect(computeWallClockTime([])).toBe(0)
  })

  it('returns duration for a single interval', () => {
    expect(computeWallClockTime([{ start: 0, end: 1000 }])).toBe(1000)
  })

  it('sums non-overlapping intervals', () => {
    const intervals = [
      { start: 0, end: 1000 },
      { start: 2000, end: 3000 },
    ]
    expect(computeWallClockTime(intervals)).toBe(2000)
  })

  it('merges fully overlapping intervals', () => {
    const intervals = [
      { start: 0, end: 2000 },
      { start: 500, end: 1500 },
    ]
    expect(computeWallClockTime(intervals)).toBe(2000)
  })

  it('merges partially overlapping intervals', () => {
    const intervals = [
      { start: 0, end: 1000 },
      { start: 500, end: 1500 },
    ]
    expect(computeWallClockTime(intervals)).toBe(1500)
  })

  it('handles parallel tool calls correctly', () => {
    // Two tools start at the same time, finish at different times
    const intervals = [
      { start: 1000, end: 2000 }, // Tool A: 1s
      { start: 1000, end: 2500 }, // Tool B: 1.5s (parallel)
    ]
    expect(computeWallClockTime(intervals)).toBe(1500)
  })

  it('handles mix of parallel and sequential intervals', () => {
    // Group 1: two parallel calls (t=0 to t=1500)
    // Gap
    // Group 2: one sequential call (t=3000 to t=4000)
    const intervals = [
      { start: 0, end: 1000 },
      { start: 0, end: 1500 },
      { start: 3000, end: 4000 },
    ]
    expect(computeWallClockTime(intervals)).toBe(2500)
  })

  it('handles unsorted intervals', () => {
    const intervals = [
      { start: 3000, end: 4000 },
      { start: 0, end: 1000 },
      { start: 500, end: 1500 },
    ]
    expect(computeWallClockTime(intervals)).toBe(2500)
  })
})
