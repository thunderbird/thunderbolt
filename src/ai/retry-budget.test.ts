/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createTurnBudget, maxRequestsPerTurn, maxTurnWallClockMs } from './retry-budget'

describe('createTurnBudget', () => {
  it('consumes requests until request capacity is exhausted', () => {
    const budget = createTurnBudget()

    for (let request = 0; request < maxRequestsPerTurn; request++) {
      expect(budget.consumer.tryConsumeRequest()).toBe(true)
    }

    expect(budget.consumer.tryConsumeRequest()).toBe(false)
    expect(budget.probe.isExhausted).toBe(true)
  })

  it('exhausts when turn wall-clock limit is reached', () => {
    const clock = { now: 1_000 }
    const budget = createTurnBudget(() => clock.now)

    expect(budget.consumer.tryConsumeRequest()).toBe(true)
    clock.now += maxTurnWallClockMs - 1
    expect(budget.probe.isExhausted).toBe(false)

    clock.now++
    expect(budget.consumer.tryConsumeRequest()).toBe(false)
    expect(budget.probe.isExhausted).toBe(true)
  })

  it('separates consuming from exhaustion probing', () => {
    const budget = createTurnBudget()

    expect(Object.keys(budget.consumer)).toEqual(['tryConsumeRequest'])
    expect(Object.keys(budget.probe)).toEqual(['isExhausted'])
    expect(budget.probe.isExhausted).toBe(false)
  })
})
