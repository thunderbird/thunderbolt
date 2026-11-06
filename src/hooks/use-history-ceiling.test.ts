/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { NavigationType } from 'react-router'
import {
  computeHistoryCeiling,
  getHistoryCeiling,
  resetHistoryCeilingForTests,
  subscribeToHistoryCeiling,
  trackHistoryCeiling,
} from './use-history-ceiling'

describe('computeHistoryCeiling', () => {
  it('raises the ceiling on PUSH to a higher index', () => {
    expect(computeHistoryCeiling(0, NavigationType.Push, 3)).toBe(3)
  })

  it('lowers the ceiling on PUSH to a lower index (forward entries are discarded)', () => {
    expect(computeHistoryCeiling(5, NavigationType.Push, 2)).toBe(2)
  })

  it('preserves the ceiling on POP below it (forward stays enabled)', () => {
    expect(computeHistoryCeiling(4, NavigationType.Pop, 1)).toBe(4)
  })

  it('raises the ceiling on POP above it (forward past the known furthest index)', () => {
    expect(computeHistoryCeiling(2, NavigationType.Pop, 5)).toBe(5)
  })

  it('preserves the ceiling on REPLACE at or below it', () => {
    expect(computeHistoryCeiling(3, NavigationType.Replace, 3)).toBe(3)
    expect(computeHistoryCeiling(3, NavigationType.Replace, 1)).toBe(3)
  })

  it('keeps the initial ceiling at 0 for the router-startup POP at index 0', () => {
    expect(computeHistoryCeiling(0, NavigationType.Pop, 0)).toBe(0)
  })
})

describe('history ceiling store', () => {
  beforeEach(() => {
    resetHistoryCeilingForTests()
  })

  afterEach(() => {
    resetHistoryCeilingForTests()
  })

  it('starts at 0', () => {
    expect(getHistoryCeiling()).toBe(0)
  })

  it('applies navigations and exposes the raised ceiling via the snapshot', () => {
    trackHistoryCeiling(NavigationType.Push, 1)
    trackHistoryCeiling(NavigationType.Push, 2)
    expect(getHistoryCeiling()).toBe(2)

    trackHistoryCeiling(NavigationType.Pop, 0)
    expect(getHistoryCeiling()).toBe(2)
  })

  it('notifies subscribers only when the ceiling actually changes', () => {
    let notifications = 0
    const unsubscribe = subscribeToHistoryCeiling(() => {
      notifications += 1
    })

    trackHistoryCeiling(NavigationType.Push, 1)
    expect(notifications).toBe(1)

    // POP below the ceiling leaves it unchanged — no notification.
    trackHistoryCeiling(NavigationType.Pop, 0)
    expect(notifications).toBe(1)

    trackHistoryCeiling(NavigationType.Push, 2)
    expect(notifications).toBe(2)

    unsubscribe()
    trackHistoryCeiling(NavigationType.Push, 3)
    expect(notifications).toBe(2)
    expect(getHistoryCeiling()).toBe(3)
  })
})
